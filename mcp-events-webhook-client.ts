import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { McpProtocolSession } from "./runtime-protocol.ts";
import { PollEventsClient } from "./mcp-events-advanced.ts";
import { createJsonSchemaValidator } from "./json-schema-validator.ts";
import { WebhookReceiver, validateWebhookSecret, type WebhookDelivery } from "./mcp-events-webhook.ts";
import type { DurableWebhookInbox } from "./mcp-events-inbox.ts";
import { UnauthorizedError, InsufficientScopeError, SdkErrorCode } from "@modelcontextprotocol/client";
import { abortable } from "./abort.ts";

class RetryableRenewalError extends Error {}
class TerminalWebhookError extends Error {}
function notFound(error: unknown, kind: "event" | "subscription"): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; data?: unknown };
  if (value.code !== -32023) return false;
  // The pinned Error Codes table makes kind optional; the operation supplies
  // context. A contradictory discriminator must never be reinterpreted.
  if (value.data === undefined) return true;
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) return false;
  const actual = (value.data as { kind?: unknown }).kind;
  return actual === undefined || actual === kind;
}
function rediscoverable(error: unknown): boolean {
  if (notFound(error, "event")) return true;
  if (!error || typeof error !== "object") return false;
  const { code, data } = error as { code?: unknown; data?: unknown };
  if (!data || typeof data !== "object") return false;
  const detail = data as { kind?: unknown; reason?: unknown; feature?: unknown };
  return code === -32026 && detail.reason === "schema_changed" && (detail.feature === "inputSchema" || detail.feature === "payloadSchema");
}
function sessionFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch transport failures do not necessarily abort the session signal.
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return ([SdkErrorCode.NotConnected, SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed, SdkErrorCode.ClientHttpFailedToOpenStream,
    "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"] as unknown[]).includes(code);
}
function retryable(error: unknown): boolean {
  if (error instanceof TerminalWebhookError || error instanceof z.ZodError) return false;
  if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError) return false;
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  if ([401, 403].includes(Number(e.status ?? e.statusCode))) return false;
  const status = Number(e.status ?? e.statusCode);
  // SDK 2.3.1 uses ClientHttpNotImplemented for generic failed POSTs too;
  // HTTP status takes precedence over that overloaded SDK error code.
  if ((status >= 500 && status <= 599) || status === 408 || status === 429) return true;
  if (typeof e.code === "number") return [-32603, -32025, -32027].includes(e.code);
  if (typeof e.code === "string" && Object.values(SdkErrorCode).includes(e.code as SdkErrorCode))
    return ([SdkErrorCode.NotConnected, SdkErrorCode.RequestTimeout, SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed,
      SdkErrorCode.ClientHttpFailedToOpenStream, SdkErrorCode.ClientHttpFailedToTerminateSession] as string[]).includes(e.code);
  return error instanceof Error;
}

export const WEBHOOK_EVENTS_PROTOCOL = { namespace: "event_webhook",
  requests: ["events/list", "events/subscribe", "events/unsubscribe"], streams: [],
  notifications: ["notifications/events/list_changed"] };
type Descriptor = Awaited<ReturnType<PollEventsClient["list"]>>[number];
export const webhookDeliveryStatusSchema = z.object({ active: z.boolean(), lastDeliveryAt: z.iso.datetime({ offset: true }).nullable().optional(),
  lastError: z.enum(["connection_refused", "timeout", "tls_error", "http_4xx", "http_5xx", "challenge_failed"]).nullable().optional(),
  failedSince: z.iso.datetime({ offset: true }).optional(), throttled: z.boolean().optional(), retryAfterMs: z.number().int().nonnegative().optional(),
});
const grant = z.object({ id: z.string().min(1).max(8192), refreshBefore: z.iso.datetime({ offset: true }).nullable(),
  cursor: z.string().max(8192).nullable().optional(), truncated: z.boolean().optional(), deliveryStatus: webhookDeliveryStatusSchema.optional() });
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;
export interface WebhookSubscriptionState {
  id: string; server: string; name: string; arguments: Record<string, unknown>;
  delivery: "webhook"; callbackUrl: string; secret: string; descriptor: Descriptor;
  /** Private write-ahead intent; uncertain refreshes reuse this key. */
  pendingSecret?: string;
  status: "opening" | "active" | "reconnecting" | "stopped" | "failed";
  remoteId?: string; cursor: string | null; refreshBefore?: string | null; ttlMs?: number | null; maxAgeMs?: number;
  truncated: boolean; cleanupPending: boolean; deliveryStatus?: WebhookDeliveryStatus;
}
export type WebhookSubscription = Omit<WebhookSubscriptionState, "secret" | "pendingSecret" | "callbackUrl" | "descriptor" | "remoteId">;
export interface WebhookEventsOptions {
  receiver: WebhookReceiver; inbox: DurableWebhookInbox; callbackBaseUrl: string; scope: string;
  /** Private durable registry writer; this state includes the signing secret. */
  save(state: WebhookSubscriptionState): Promise<void>;
  onPending(subscriptionId: string): void | Promise<void>;
  /** Return an owned mediated session for the same configured/authenticated context. */
  reconnect?(previous: McpProtocolSession, signal: AbortSignal): Promise<McpProtocolSession>;
}
interface Item {
  state: WebhookSubscriptionState;
  route: ReturnType<WebhookReceiver["register"]>;
  timer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  renewalAbort?: AbortController;
  retries: number;
  flight?: Promise<void>;
  notifyPending: boolean;
  dirty: boolean;
  restoring?: boolean;
  descriptorFlight?: Promise<void>;
  rotationFlight?: Promise<WebhookSubscription>;
  pendingKeySave?: Promise<void>;
  rediscoveryAttempts?: number;
}
const publicState = (state: WebhookSubscriptionState): WebhookSubscription => {
  const { secret: _secret, pendingSecret: _pending, callbackUrl: _url, descriptor: _descriptor, remoteId: _remote, ...visible } = state;
  return structuredClone(visible);
};

/** SDK-mediated webhook driver. No transport, API key, or secret reaches Pi tools. */
export class WebhookEventsClient {
  private items = new Map<string, Item>();
  private closed = false;
  private catalog: PollEventsClient;
  private watch: ReturnType<McpProtocolSession["watchNotifications"]>;
  private callbackBase: URL;
  private currentSession: McpProtocolSession;
  private readonly originalBinding: string | undefined;
  private readonly lifetime = new AbortController();
  private connectionFlight?: Promise<McpProtocolSession>;
  private replacementNeeded = false;
  get session(): McpProtocolSession { return this.currentSession; }
  constructor(readonly server: string, session: McpProtocolSession, private options: WebhookEventsOptions) {
    this.currentSession = session; this.originalBinding = session.serverBinding;
    this.callbackBase = new URL(options.callbackBaseUrl);
    if (this.callbackBase.protocol !== "https:" || this.callbackBase.username || this.callbackBase.password || this.callbackBase.search || this.callbackBase.hash)
      throw new Error("Webhook callback base must be an HTTPS URL without credentials, query or fragment");
    if (!options.scope) throw new Error("Pi session scope is required");
    this.catalog = new PollEventsClient(server, session, () => {});
    this.watch = session.watchNotifications(WEBHOOK_EVENTS_PROTOCOL.notifications, () => { for (const item of this.items.values()) item.dirty = true; });
    session.signal.addEventListener("abort", this.disconnected, { once: true });
  }
  private disconnected = () => {
    if (this.closed) return;
    for (const item of this.items.values()) if (["active", "reconnecting"].includes(item.state.status) && !item.flight) {
      clearTimeout(item.timer);
      void this.recover(item, new RetryableRenewalError("MCP session disconnected")).catch(() => {});
    }
  };
  private async availableSession(signal?: AbortSignal): Promise<McpProtocolSession> {
    signal?.throwIfAborted();
    if (!this.session.signal.aborted && !this.replacementNeeded) return this.session;
    if (this.closed || !this.options.reconnect || !this.originalBinding) throw new TerminalWebhookError("Webhook session replacement unavailable");
    if (!this.connectionFlight) {
      const previous = this.session;
      this.connectionFlight = Promise.resolve().then(() => this.options.reconnect!(previous, this.lifetime.signal)).then(next => {
        if (this.closed || this.lifetime.signal.aborted || next.signal.aborted || next.serverBinding !== this.originalBinding) {
          next.close(); throw new TerminalWebhookError("Webhook session replacement rejected");
        }
        let watch: typeof this.watch;
        try { watch = next.watchNotifications(WEBHOOK_EVENTS_PROTOCOL.notifications, () => { for (const item of this.items.values()) item.dirty = true; }); }
        catch { next.close(); throw new TerminalWebhookError("Webhook session replacement rejected"); }
        previous.signal.removeEventListener("abort", this.disconnected); this.watch.close(); previous.close();
        this.currentSession = next; this.watch = watch; this.replacementNeeded = false;
        this.catalog = new PollEventsClient(this.server, next, () => {});
        for (const item of this.items.values()) item.dirty = true;
        next.signal.addEventListener("abort", this.disconnected, { once: true });
        return next;
      }, error => {
        if (retryable(error)) throw new RetryableRenewalError("Transient webhook session replacement failure");
        throw new TerminalWebhookError("Webhook session replacement rejected");
      }).finally(() => { delete this.connectionFlight; });
    }
    return abortable(this.connectionFlight, signal);
  }
  async list(signal?: AbortSignal) { await this.availableSession(signal); return this.catalog.list(signal); }
  status(id?: string): WebhookSubscription[] {
    if (id && !this.items.has(id)) throw new Error("Unknown webhook subscription");
    return [...this.items.values()].filter(item => !id || item.state.id === id).map(item => publicState(item.state));
  }
  async restore(states: WebhookSubscriptionState[], signal?: AbortSignal): Promise<WebhookSubscription[]> {
    if (this.closed || states.length + this.items.size > 100) throw new Error("Invalid Events restoration");
    const restored: WebhookSubscription[] = [];
    const prepared: WebhookSubscriptionState[] = [];
    const identities = new Set<string>();
    // Validate the whole registry batch before starting any of its workers.
    for (const original of states) {
      signal?.throwIfAborted();
      const state = structuredClone(original);
      validateWebhookSecret(state.secret);
      if (state.pendingSecret !== undefined) validateWebhookSecret(state.pendingSecret);
      const expected = new URL(this.callbackBase);
      expected.pathname = expected.pathname.replace(/\/$/, "") + "/" + z.uuid().parse(state.id);
      if (state.server !== this.server || state.delivery !== "webhook" || state.callbackUrl !== expected.href || this.items.has(state.id) || identities.has(state.id))
        throw new Error("Stored webhook subscription does not match this receiver/server");
      identities.add(state.id);
      // Revocation removes permission to resume, not permission to clean up
      // an already-created remote subscription using its original tuple.
      if (!state.cleanupPending && state.status !== "stopped") {
        const current = (await this.list(signal)).find(entry => entry.name === state.name);
        if (!current?.delivery.includes("webhook") || !createJsonSchemaValidator().getValidator(current.inputSchema)(state.arguments).valid)
          throw new Error("Stored event subscription is no longer advertised");
        state.descriptor = current;
      }
      prepared.push(state);
    }
    const installed: Item[] = [];
    try {
      for (const state of prepared) {
        signal?.throwIfAborted();
        const item = this.install(state); item.restoring = true; installed.push(item);
        if (state.cleanupPending || state.status === "stopped") await this.unsubscribe(state.id);
        else if (state.status !== "failed") {
          state.status = "reconnecting";
          try { await this.refresh(item, signal); }
          catch (error) {
            if (!(error instanceof RetryableRenewalError) || !state.remoteId || state.refreshBefore === undefined) throw error;
            await this.recover(item, error);
          }
        } else item.route.close();
        restored.push(publicState(state));
      }
    } catch (error) {
      for (const item of installed) {
        // Local rollback must not replace the last durable running intent.
        item.state.status = "stopped"; clearTimeout(item.timer); clearTimeout(item.deadlineTimer); item.renewalAbort?.abort(); item.route.close(); this.items.delete(item.state.id);
      }
      await Promise.allSettled(installed.map(item => item.flight));
      throw error;
    }
    for (const item of installed) {
      item.restoring = false;
      if (item.state.status === "active" && (await this.options.inbox.pending(`${this.options.scope}/${item.state.id}`)).length) {
        await this.options.onPending(item.state.id); item.notifyPending = false;
      }
    }
    return restored;
  }
  async subscribe(name: string, args: Record<string, unknown> = {}, options: { cursor?: string | null; maxAgeMs?: number; ttlMs?: number | null } = {}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Events session ended");
    if (this.items.size >= 100) throw new Error("Webhook subscription limit reached");
    if (options.ttlMs !== undefined && options.ttlMs !== null && (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 0)) throw new Error("Invalid ttlMs");
    if (options.maxAgeMs !== undefined && (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 0)) throw new Error("Invalid maxAgeMs");
    const descriptor = (await this.list(signal)).find(entry => entry.name === name);
    if (!descriptor?.delivery.includes("webhook")) throw new Error("Event does not advertise webhook delivery");
    if (!createJsonSchemaValidator().getValidator(descriptor.inputSchema)(args).valid) throw new Error("Event arguments do not match inputSchema");
    const id = randomUUID();
    const base = new URL(this.callbackBase);
    base.pathname = base.pathname.replace(/\/$/, "") + "/" + id;
    const state: WebhookSubscriptionState = { id, server: this.server, name, arguments: structuredClone(args), delivery: "webhook",
      callbackUrl: base.href, secret: "whsec_" + randomBytes(32).toString("base64"), descriptor,
      status: "opening", cursor: options.cursor ?? null, truncated: false, cleanupPending: false,
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }), ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }) };
    // The secret and subscription intent must precede the first signed challenge.
    await this.options.save(structuredClone(state));
    const item = this.install(state);
    try { await this.refresh(item, signal); return publicState(state); }
    catch {
      clearTimeout(item.timer); item.route.close(); state.status = "failed"; state.cleanupPending = true;
      await this.options.save(structuredClone(state));
      throw new Error("Webhook subscription registration failed; cleanup is pending");
    }
  }
  private install(state: WebhookSubscriptionState): Item {
    let item!: Item;
    const route = this.options.receiver.register({ path: new URL(state.callbackUrl).pathname, secret: state.secret,
      name: state.name, payloadSchema: state.descriptor.payloadSchema,
      accept: (delivery, deliveryId) => this.accept(item, delivery, deliveryId) });
    try {
      item = { state, route, notifyPending: false, dirty: false, retries: 0 };
      if (state.pendingSecret !== undefined) route.updateSecrets([state.secret, state.pendingSecret]);
      if (state.remoteId) route.activate(state.remoteId);
      this.items.set(state.id, item);
      return item;
    } catch (error) { route.close(); throw error; }
  }
  private async accept(item: Item, delivery: WebhookDelivery, deliveryId: string) {
    const state = item.state;
    if (this.closed || !["active", "reconnecting"].includes(state.status)) throw new Error("Subscription is not accepting deliveries");
    // Signed lifecycle controls remain meaningful after descriptor removal;
    // only event payloads depend on the currently advertised schema.
    if (!("type" in delivery)) await this.updateDescriptor(item);
    if (this.closed || !["active", "reconnecting"].includes(state.status)) throw new Error("Subscription is not accepting deliveries");
    if (!("type" in delivery) && !createJsonSchemaValidator().getValidator(state.descriptor.payloadSchema)(delivery.data).valid)
      throw new Error("Event payload no longer matches its advertised schema");
    const fresh = await this.options.inbox.accept(`${this.options.scope}/${state.id}`, deliveryId, delivery);
    let restart = false;
    item.notifyPending ||= fresh;
    if (!("type" in delivery) || delivery.type === "gap") {
      state.cursor = typeof delivery.cursor === "string" ? delivery.cursor : null;
      if (delivery.type === "gap" && state.cursor !== null) state.truncated = true;
    } else if (delivery.type === "terminated") {
      clearTimeout(item.timer); clearTimeout(item.deadlineTimer);
      restart = rediscoverable(delivery.error);
      state.cleanupPending = false; // Termination confirms that remote state ended.
      if (restart) {
        state.status = "reconnecting"; item.dirty = true; item.rediscoveryAttempts ??= 0;
        item.renewalAbort?.abort(new RetryableRenewalError("Event descriptor changed"));
      } else {
        item.renewalAbort?.abort(); item.route.close(); state.status = "failed";
      }
    }
    // Checkpoint only after acceptance; duplicate deliveries can advance a watermark.
    await this.options.save(structuredClone(state));
    if (item.notifyPending && !item.restoring) { await this.options.onPending(state.id); item.notifyPending = false; }
    if (restart) await this.recover(item, new RetryableRenewalError("Event descriptor changed"));
  }
  private async updateDescriptor(item: Item, signal?: AbortSignal): Promise<void> {
    if (item.descriptorFlight) return item.descriptorFlight;
    if (!item.dirty) return;
    item.dirty = false;
    item.descriptorFlight = (async () => {
      const current = (await this.list(signal).catch(error => {
        if (retryable(error) && (!signal?.aborted || this.session.signal.aborted)) {
          if (this.options.reconnect && sessionFailure(error)) this.replacementNeeded = true;
          throw new RetryableRenewalError("Transient event discovery failure");
        }
        throw new TerminalWebhookError("Event discovery rejected");
      })).find(entry => entry.name === item.state.name);
      if (!current && item.rediscoveryAttempts !== undefined) throw new RetryableRenewalError("Event descriptor is not yet available");
      if (!current?.delivery.includes("webhook") || !createJsonSchemaValidator().getValidator(current.inputSchema)(item.state.arguments).valid)
        throw new Error("Event descriptor no longer permits subscription");
      item.route.updatePayloadSchema(current.payloadSchema);
      item.state.descriptor = current;
    })().catch(error => { item.dirty = true; throw error; }).finally(() => { delete item.descriptorFlight; });
    await item.descriptorFlight;
    // A second list_changed during discovery must not be accidentally cleared.
    if (item.dirty) await this.updateDescriptor(item, signal);
  }
  private async refresh(item: Item, signal?: AbortSignal): Promise<void> {
    if (item.flight) return item.flight;
    clearTimeout(item.timer);
    const abort = new AbortController(); item.renewalAbort = abort;
    const requestSignal = AbortSignal.any([abort.signal, this.lifetime.signal, ...(signal ? [signal] : [])]);
    item.flight = (async () => {
      const state = item.state;
      // Only a durability barrier, never a lock across network callbacks.
      await item.pendingKeySave;
      if (this.closed || state.status === "stopped" || state.status === "failed") throw new Error("Subscription stopped");
      const session = await this.availableSession(requestSignal);
      const wireSignal = AbortSignal.any([requestSignal, session.signal]);
      if (item.rediscoveryAttempts !== undefined && item.rediscoveryAttempts++ >= 5) throw new TerminalWebhookError("Event rediscovery attempts exhausted");
      await this.updateDescriptor(item, wireSignal);
      const sentSecret = state.pendingSecret ?? state.secret;
      const result = grant.parse(await session.request("events/subscribe", {
        name: state.name, arguments: state.arguments, delivery: { mode: "webhook", url: state.callbackUrl, secret: sentSecret }, cursor: state.cursor,
        ...(state.maxAgeMs === undefined ? {} : { maxAgeMs: state.maxAgeMs }), ...(state.ttlMs === undefined ? {} : { ttlMs: state.ttlMs }),
      }, wireSignal).catch(error => {
        if (requestSignal.reason instanceof RetryableRenewalError) throw requestSignal.reason;
        if ((retryable(error) || (item.rediscoveryAttempts !== undefined && rediscoverable(error))) && !requestSignal.aborted) {
          if (this.options.reconnect && sessionFailure(error)) this.replacementNeeded = true;
          throw new RetryableRenewalError("Transient webhook renewal failure");
        }
        throw new TerminalWebhookError("Webhook renewal rejected");
      }));
      if (session !== this.session || session.signal.aborted) throw new RetryableRenewalError("Webhook session changed during renewal");
      if (this.closed || ["stopped", "failed"].includes(state.status)) throw new Error("Subscription stopped during registration");
      if (result.refreshBefore === null && state.ttlMs !== null) throw new Error("Unrequested no-expiry grant");
      if (result.refreshBefore !== null && Date.parse(result.refreshBefore) <= Date.now()) throw new Error("Expired subscription grant");
      if (state.remoteId && state.remoteId !== result.id) throw new Error("Webhook subscription identity changed");
      state.remoteId = result.id; state.refreshBefore = result.refreshBefore; state.cursor = result.cursor ?? null;
      state.truncated ||= !!result.truncated && state.cursor !== null;
      if (result.deliveryStatus) state.deliveryStatus = result.deliveryStatus;
      state.status = "active"; state.cleanupPending = false;
      state.secret = sentSecret;
      if (state.pendingSecret === sentSecret) delete state.pendingSecret;
      await this.options.save(structuredClone(state));
      if (this.closed || requestSignal.aborted || state.status !== "active") throw new Error("Subscription stopped during registration");
      item.route.updateSecrets([state.secret, ...(state.pendingSecret ? [state.pendingSecret] : [])]); item.retries = 0; delete item.rediscoveryAttempts;
      item.route.activate(result.id);
      this.schedule(item);
    })().finally(() => { delete item.flight; delete item.renewalAbort; });
    return item.flight;
  }
  private armDeadline(item: Item) {
    clearTimeout(item.deadlineTimer);
    if (item.state.refreshBefore !== null && item.state.refreshBefore !== undefined) {
      const expire = () => {
        const left = Date.parse(item.state.refreshBefore!) - Date.now();
        if (left > 0) { item.deadlineTimer = setTimeout(expire, Math.min(2147483647, left)); item.deadlineTimer.unref?.(); }
        else void this.fail(item).catch(() => {});
      };
      item.deadlineTimer = setTimeout(expire, Math.min(2147483647, Math.max(1, Date.parse(item.state.refreshBefore) - Date.now()))); item.deadlineTimer.unref?.();
    }
  }
  private schedule(item: Item) {
    if (this.closed || item.state.status !== "active") return;
    this.armDeadline(item);
    const remaining = item.state.refreshBefore === null ? 3600000 : Date.parse(item.state.refreshBefore!) - Date.now();
    item.timer = setTimeout(() => {
      item.dirty = true; // Also bound descriptor staleness without a live notification connection.
      void this.refresh(item).catch(error => this.recover(item, error)).catch(() => {});
    }, Math.min(2147483647, Math.max(1, Math.floor(remaining * 0.8))));
    item.timer.unref?.();
  }
  private async fail(item: Item) {
    clearTimeout(item.timer); clearTimeout(item.deadlineTimer); item.renewalAbort?.abort(); item.route.close();
    item.state.status = "failed"; item.state.cleanupPending = true;
    await this.options.save(structuredClone(item.state));
  }
  private async recover(item: Item, error: unknown) {
    if (this.closed || ["stopped", "failed"].includes(item.state.status)) return;
    const left = item.state.refreshBefore === null ? Infinity : Date.parse(item.state.refreshBefore!) - Date.now();
    if (!(error instanceof RetryableRenewalError) || left <= 1) return this.fail(item);
    item.state.status = "reconnecting";
    clearTimeout(item.timer);
    this.armDeadline(item);
    await this.options.save(structuredClone(item.state));
    if (this.closed || ["stopped", "failed"].includes(item.state.status)) return;
    // Webhook delivery is independent of the MCP connection. Keep the callback
    // through its grant even when the embedding host cannot replace sessions.
    if (this.session.signal.aborted && !this.options.reconnect) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(item.retries++, 5), Math.max(1, Math.floor(left / 2)));
    clearTimeout(item.timer);
    item.timer = setTimeout(() => { void this.refresh(item).catch(e => this.recover(item, e)).catch(() => {}); }, delay);
    item.timer.unref?.();
  }
  /** Client-driven replacement on the existing authenticated tuple; never accepts a hand-picked key. */
  async rotateSecret(id: string, signal?: AbortSignal): Promise<WebhookSubscription> {
    const item = this.items.get(id);
    if (!item || this.closed || !["active", "reconnecting"].includes(item.state.status)) throw new Error("Webhook subscription is not active");
    if (item.rotationFlight) return item.rotationFlight;
    item.rotationFlight = this.rotate(item, signal).finally(() => { delete item.rotationFlight; });
    return item.rotationFlight;
  }
  private async rotate(item: Item, signal?: AbortSignal): Promise<WebhookSubscription> {
    await item.flight;
    signal?.throwIfAborted();
    if (this.closed || !["active", "reconnecting"].includes(item.state.status)) throw new Error("Webhook subscription is not active");
    const pendingSecret = item.state.pendingSecret ?? "whsec_" + randomBytes(32).toString("base64");
    clearTimeout(item.timer);
    // Publish before callbacks snapshot state; wire use waits for this write.
    item.state.pendingSecret = pendingSecret;
    item.pendingKeySave = this.options.save(structuredClone(item.state));
    await item.pendingKeySave;
    if (this.closed || !["active", "reconnecting"].includes(item.state.status)) {
      await this.options.save(structuredClone(item.state));
      throw new Error("Webhook subscription is not active");
    }
    item.route.updateSecrets([item.state.secret, item.state.pendingSecret]);
    try { await this.refresh(item, signal); return publicState(item.state); }
    catch (error) { await this.recover(item, error); throw new Error("Webhook secret rotation failed; private recovery state retained"); }
  }
  async unsubscribe(id: string) {
    const item = this.items.get(id);
    if (!item) return { stopped: true };
    clearTimeout(item.timer); clearTimeout(item.deadlineTimer); item.state.status = "stopped"; item.state.cleanupPending = true;
    await this.options.save(structuredClone(item.state));
    item.route.close();
    item.renewalAbort?.abort();
    // Settle local registration before authenticated tuple cleanup; neither
    // cancellation nor a lost response proves what the remote server applied.
    await item.flight?.catch(() => {});
    try {
      const session = await this.availableSession();
      await session.request("events/unsubscribe", { name: item.state.name, arguments: item.state.arguments, delivery: { url: item.state.callbackUrl } });
    } catch (error) {
      if (!notFound(error, "subscription")) throw error;
    }
    item.state.cleanupPending = false;
    await this.options.save(structuredClone(item.state));
    return { stopped: true };
  }
  async close() {
    this.closed = true;
    this.lifetime.abort(); this.session.signal.removeEventListener("abort", this.disconnected);
    await Promise.allSettled([...this.items.keys()].map(id => this.unsubscribe(id)));
    this.watch.close(); this.session.close();
  }
  /** Stop local delivery without cancelling persisted remote subscription intent. */
  async suspend() {
    this.closed = true;
    this.lifetime.abort(); this.session.signal.removeEventListener("abort", this.disconnected);
    for (const item of this.items.values()) { clearTimeout(item.timer); clearTimeout(item.deadlineTimer); item.renewalAbort?.abort(); item.route.close(); }
    await Promise.allSettled([...this.items.values()].map(item => item.flight));
    this.watch.close(); this.session.close();
  }
}
