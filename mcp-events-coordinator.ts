import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { PollEventsClient } from "./mcp-events-advanced.ts";
import { EventConnection, type Subscription } from "./event-companion/src/stream.ts";
import { WebhookEventsClient, webhookDeliveryStatusSchema, type WebhookDeliveryStatus, type WebhookSubscriptionState } from "./mcp-events-webhook-client.ts";
import type { WebhookReceiver } from "./mcp-events-webhook.ts";
import type { DurableWebhookInbox } from "./mcp-events-inbox.ts";
import type { EventsRegistry, StoredEventSubscription } from "./mcp-events-registry.ts";
import type { McpProtocolSession } from "./runtime-protocol.ts";
import { createJsonSchemaValidator } from "./json-schema-validator.ts";
import { stableStringify } from "./utils.ts";
import type { EventDeliverySource, PendingEventDelivery } from "./mcp-events-pi-delivery.ts";
export type { PendingEventDelivery } from "./mcp-events-pi-delivery.ts";

/** One mediated registration; the existing drivers never own SDK transports. */
export const EVENTS_COORDINATOR_PROTOCOL = { namespace: "events",
  requests: ["events/list", "events/poll", "events/subscribe", "events/unsubscribe"], streams: ["events/stream"],
  notifications: ["notifications/events/list_changed", "notifications/events/active", "notifications/events/event",
    "notifications/events/heartbeat", "notifications/events/error", "notifications/events/terminated"] };
type Mode = StoredEventSubscription["delivery"];
type Descriptor = Awaited<ReturnType<PollEventsClient["list"]>>[number];
export type EventSubscription = Omit<StoredEventSubscription, "driverState"> & { deliveryStatus?: WebhookDeliveryStatus };
/** Application diagnostics only; deliberately excludes payloads/private state. */
export type EventSubscriptionStatus = Readonly<Pick<EventSubscription, "server" | "name" | "delivery" | "status"> & { subscriptionId: string }>;
export interface EventsSubscribeOptions {
  server: string; name: string; arguments?: Record<string, unknown>;
  delivery?: Mode | "auto"; cursor?: string | null; maxAgeMs?: number; ttlMs?: number | null;
}
export interface EventsCoordinatorOptions {
  sessionId: string; registry: EventsRegistry; inbox: DurableWebhookInbox;
  /** Connect using EVENTS_COORDINATOR_PROTOCOL. Each call returns an owned session. */
  connect(server: string): Promise<McpProtocolSession>;
  webhook?: { receiver: WebhookReceiver; callbackBaseUrl: string };
  onPending?(subscriptionId: string): void | Promise<void>;
  /** Called after committed status changes; observer errors cannot change delivery. */
  onStatus?(status: EventSubscriptionStatus): void;
}
const occurrence = z.object({ eventId: z.string().min(1).max(1024), name: z.string().min(1).max(256),
  timestamp: z.iso.datetime({ offset: true }), data: z.record(z.string(), z.unknown()), cursor: z.string().nullable().optional() });
const privateState = z.object({ version: z.literal(1), serverBinding: z.string().nullable(),
  requestedDelivery: z.enum(["auto", "poll", "push", "webhook"]), webhook: z.record(z.string(), z.unknown()).optional() });
const descriptorSchema = z.object({ name: z.string().min(1), delivery: z.array(z.enum(["poll", "push", "webhook"])).min(1),
  inputSchema: z.record(z.string(), z.unknown()), payloadSchema: z.record(z.string(), z.unknown()), description: z.string().optional() });
const signingSecret = z.string().refine(value => {
    if (!value.startsWith("whsec_")) return false;
    const key = value.slice(6), bytes = Buffer.from(key, "base64");
    return bytes.length >= 24 && bytes.length <= 64 && bytes.toString("base64") === key;
  });
const webhookState = z.object({ id: z.uuid(), server: z.string().min(1), name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()), delivery: z.literal("webhook"), callbackUrl: z.url(),
  secret: signingSecret, pendingSecret: signingSecret.optional(), descriptor: descriptorSchema, status: z.enum(["opening", "active", "reconnecting", "stopped", "failed"]),
  cursor: z.string().nullable(), truncated: z.boolean(), cleanupPending: z.boolean(),
  remoteId: z.string().min(1).optional(), refreshBefore: z.iso.datetime({ offset: true }).nullable().optional(),
  ttlMs: z.number().int().nonnegative().nullable().optional(), maxAgeMs: z.number().int().nonnegative().optional(),
  deliveryStatus: webhookDeliveryStatusSchema.optional(),
}).passthrough();
interface Managed {
  entry: StoredEventSubscription; session: McpProtocolSession; descriptor: Descriptor;
  queue: Promise<void>; failure?: string; stopping: boolean; dirty: boolean;
  stop(): void | Promise<unknown>; suspend(): void | Promise<unknown>; detach(): void;
  rotate?(signal?: AbortSignal): Promise<unknown>;
}

/** Coordinates durable acceptance, not exactly-once agent actions. The caller
 * acknowledges pending records only AFTER the corresponding Pi turn completes.
 * close() suspends local workers and preserves running intent for restoration. */
export class EventsCoordinator implements EventDeliverySource {
  private managed = new Map<string, Managed>();
  private operations: Promise<void> = Promise.resolve();
  private closed = false;
  private closeFlight: Promise<void> | undefined;
  constructor(private options: EventsCoordinatorOptions) {
    if (!options.sessionId || options.registry.sessionId !== options.sessionId)
      throw new Error("Events registry belongs to another Pi session");
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Events coordinator is closed"));
    const result = this.operations.then(work);
    this.operations = result.then(() => {}, () => {});
    return result;
  }
  private enqueue<T>(m: Managed, work: () => Promise<T>): Promise<T> {
    const result = m.queue.then(work);
    m.queue = result.then(() => {}, () => { m.failure = "Events persistence or delivery failed"; });
    return result;
  }
  private scope(id: string) { return `${this.options.sessionId}/${id}`; }
  private async save(m: Managed, patch: Partial<StoredEventSubscription>) {
    const next = { ...m.entry, ...patch };
    await this.persist(m, next);
  }
  private async persist(m: Managed, next: StoredEventSubscription) {
    const previous = this.options.registry.list().find(row => row.id === next.id)?.status;
    await this.options.registry.save(next); m.entry = next;
    this.notifyStatus(previous, next);
  }
  private notifyStatus(previous: StoredEventSubscription["status"] | undefined, next: StoredEventSubscription) {
    if (previous !== next.status) {
      const status: EventSubscriptionStatus = Object.freeze({ subscriptionId: next.id, server: next.server,
        name: next.name, delivery: next.delivery, status: next.status });
      try { void Promise.resolve(this.options.onStatus?.(status)).catch(() => {}); }
      catch { /* Observers are not delivery/recovery authority. */ }
    }
  }
  list(): EventSubscription[] {
    return this.options.registry.list().map(({ driverState, ...entry }) => {
      const diagnostics = entry.delivery === "webhook" && driverState
        ? webhookDeliveryStatusSchema.optional().parse(privateState.parse(driverState).webhook?.deliveryStatus) : undefined;
      return { ...entry, ...(diagnostics ? { deliveryStatus: diagnostics } : {}),
        ...(this.managed.get(entry.id)?.failure ? { status: "failed" as const } : {}) };
    });
  }
  async catalog(server: string, signal?: AbortSignal): Promise<Descriptor[]> {
    if (this.closed) throw new Error("Events coordinator is closed");
    const session = await this.options.connect(server);
    try { return await new PollEventsClient(server, session, () => {}).list(signal); }
    finally { session.close(); }
  }
  private async descriptor(session: McpProtocolSession, entry: Pick<StoredEventSubscription, "server" | "name" | "arguments" | "delivery">, signal?: AbortSignal) {
    const descriptor = (await new PollEventsClient(entry.server, session, () => {}).list(signal)).find(d => d.name === entry.name);
    if (!descriptor || !descriptor.delivery.includes(entry.delivery)) throw new Error("Requested Events delivery is not advertised");
    if (!createJsonSchemaValidator().getValidator(descriptor.inputSchema)(entry.arguments).valid)
      throw new Error("Event arguments do not match inputSchema");
    return descriptor;
  }
  private restoredWebhook(entry: StoredEventSubscription): WebhookSubscriptionState {
    const state = webhookState.parse(privateState.parse(entry.driverState).webhook);
    const base = this.options.webhook?.callbackBaseUrl;
    if (!base) throw new Error("Webhook receiver is not configured");
    const expected = new URL(base); expected.pathname = expected.pathname.replace(/\/$/, "") + "/" + entry.id;
    if (state.id !== entry.id || state.server !== entry.server || state.name !== entry.name || state.callbackUrl !== expected.href ||
      state.cursor !== entry.cursor || state.status !== entry.status || stableStringify(state.arguments) !== stableStringify(entry.arguments))
      throw new Error("Invalid webhook restoration state");
    return state as WebhookSubscriptionState;
  }
  subscribe(raw: EventsSubscribeOptions, signal?: AbortSignal): Promise<EventSubscription> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const input = z.object({ server: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}),
        delivery: z.enum(["auto", "poll", "push", "webhook"]).default("auto"), cursor: z.string().max(8192).nullable().optional(),
        maxAgeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), ttlMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
      }).parse(raw);
      if (Buffer.byteLength(JSON.stringify(input.arguments)) > 32768) throw new Error("Event arguments exceed delivery budget");
      const session = await this.options.connect(input.server);
      let m: Managed | undefined;
      try {
        const descriptor = (await new PollEventsClient(input.server, session, () => {}).list(signal)).find(d => d.name === input.name);
        const available = descriptor?.delivery ?? [];
        const delivery = input.delivery === "auto"
          ? ([...(this.options.webhook ? ["webhook" as const] : []), "push", "poll"] as Mode[]).find(mode => available.includes(mode))
          : input.delivery;
        if (!descriptor || !delivery || !available.includes(delivery) || (delivery === "webhook" && !this.options.webhook))
          throw new Error("Requested Events delivery is unavailable");
        if (!createJsonSchemaValidator().getValidator(descriptor.inputSchema)(input.arguments).valid)
          throw new Error("Event arguments do not match inputSchema");
        const entry: StoredEventSubscription = { id: randomUUID(), server: input.server, name: input.name,
          arguments: structuredClone(input.arguments), delivery, status: "opening", cursor: input.cursor ?? null, truncated: false,
          ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
          driverState: { version: 1, serverBinding: session.serverBinding ?? null, requestedDelivery: input.delivery } };
        m = this.prepare(entry, session, descriptor);
        if (delivery !== "webhook") { await this.persist(m, entry); this.managed.set(entry.id, m); }
        await this.launch(m, false, input.ttlMs, signal);
        return this.list().find(row => row.id === m!.entry.id)!;
      } catch (error) {
        if (m) {
          m.stopping = true; await m.suspend(); m.detach(); await m.queue;
          if (this.options.registry.list().some(e => e.id === m!.entry.id))
            await this.enqueue(m, () => this.save(m!, { status: "failed" }));
          this.managed.delete(m.entry.id);
        } else session.close();
        // Driver errors can contain server text or private callback information.
        throw new Error(error instanceof z.ZodError ? "Invalid Events subscription" : "Events subscription failed; requested delivery was not downgraded");
      }
    });
  }
  private prepare(entry: StoredEventSubscription, session: McpProtocolSession, descriptor: Descriptor): Managed {
    const m: Managed = { entry: structuredClone(entry), session, descriptor, queue: Promise.resolve(), stopping: false, dirty: false,
      stop() {}, suspend() { session.close(); }, detach() {} };
    const watch = session.watchNotifications(["notifications/events/list_changed"], () => { m.dirty = true; });
    m.detach = () => watch.close();
    return m;
  }
  private accept(m: Managed, events: unknown[], cursor: string | null, truncated = false, active = false) {
    return this.enqueue(m, async () => {
      if (m.stopping) return;
      while (m.dirty) { m.dirty = false; m.descriptor = await this.descriptor(m.session, m.entry); }
      const validator = createJsonSchemaValidator().getValidator(m.descriptor.payloadSchema);
      const parsed = events.map(value => occurrence.parse(value));
      for (const event of parsed)
        if (event.name !== m.entry.name || !validator(event.data).valid) throw new Error("Invalid Events payload");
      let pending = false;
      for (const event of parsed) pending = (await this.options.inbox.accept(this.scope(m.entry.id), event.eventId, event)) || pending;
      await this.save(m, { cursor, truncated: m.entry.truncated || truncated, ...(active ? { status: "active" as const } : {}) });
      if (pending) await this.options.onPending?.(m.entry.id);
    });
  }
  private async launch(m: Managed, restoring: boolean, ttlMs?: number | null, signal?: AbortSignal) {
    const entry = m.entry;
    if (entry.delivery === "poll") {
      const client = new PollEventsClient(entry.server, m.session, async raw => {
        const body = raw as { events?: unknown[]; cursor?: string | null; truncated?: boolean; status?: string };
        if (body.status === "failed") { await this.enqueue(m, () => this.save(m, { status: "failed" })); return; }
        if (body.status === "reconnecting") { await this.enqueue(m, () => this.save(m, { status: "reconnecting" })); return; }
        await this.accept(m, body.events ?? [], body.cursor ?? null, !!body.truncated, true);
      }, 1000, { reconnect: async () => {
        const next = await this.options.connect(entry.server);
        try {
        if (m.stopping || this.closed || !m.session.serverBinding || next.serverBinding !== m.session.serverBinding) {
          next.close(); throw new Error("Events reconnect binding mismatch");
        }
        const descriptor = await this.descriptor(next, m.entry);
        const watch = next.watchNotifications(["notifications/events/list_changed"], () => { m.dirty = true; });
        m.detach(); m.detach = () => watch.close(); m.session = next; m.descriptor = descriptor;
        return next;
        } catch (error) { next.close(); throw error; }
      } });
      let driverId: string | undefined;
      m.stop = () => { if (driverId) client.unsubscribe(driverId); client.close(); };
      m.suspend = () => client.close();
      const sub = await client.subscribe(entry.name, entry.arguments, entry.cursor, entry.maxAgeMs, signal); driverId = sub.id;
      await this.enqueue(m, () => this.save(m, { status: sub.status }));
    } else if (entry.delivery === "push") {
      const checkpoint = (sub: Subscription) => this.accept(m, [], sub.cursor, !!sub.truncated, true);
      const client = new EventConnection(entry.server, m.session, () => {}, sub => {
        if (m.stopping) return;
        const status = sub.status === "ended" ? "stopped" : sub.status;
        void this.enqueue(m, () => this.save(m, { status })).catch(() => {});
      }, () => {}, 15000, {
        acceptEvent: (sub, event) => this.accept(m, [event], sub.cursor, !!sub.truncated), checkpoint,
        reconnect: async () => {
          const next = await this.options.connect(entry.server);
          try {
            if (m.stopping || this.closed || !m.session.serverBinding || next.serverBinding !== m.session.serverBinding)
              throw new Error("Events connection binding changed or subscription stopped");
            const descriptor = await this.descriptor(next, m.entry);
            const watch = next.watchNotifications(["notifications/events/list_changed"], () => { m.dirty = true; });
            m.detach(); m.detach = () => watch.close();
            m.session = next; m.descriptor = descriptor; return next;
          } catch (error) { next.close(); throw error; }
        },
      });
      m.stop = m.suspend = () => client.close();
      await client.subscribe(entry.name, entry.arguments, entry.cursor, signal, entry.maxAgeMs);
    } else {
      const webhook = this.options.webhook;
      if (!webhook) throw new Error("Webhook receiver is not configured");
      const client = new WebhookEventsClient(entry.server, m.session, { ...webhook, inbox: this.options.inbox, scope: this.options.sessionId,
        reconnect: async (previous, signal) => {
          signal.throwIfAborted();
          const next = await this.options.connect(entry.server);
          try {
            if (m.stopping || this.closed || signal.aborted || !previous.serverBinding || next.serverBinding !== previous.serverBinding)
              throw new Error("Events reconnect binding mismatch");
            const descriptor = await this.descriptor(next, m.entry, signal);
            const watch = next.watchNotifications(["notifications/events/list_changed"], () => { m.dirty = true; });
            m.detach(); m.detach = () => watch.close(); m.session = next; m.descriptor = descriptor;
            return next;
          } catch (error) { next.close(); throw error; }
        },
        save: state => this.enqueue(m, async () => {
          const oldId = m.entry.id;
          const next: StoredEventSubscription = { ...m.entry, id: state.id, status: state.status, cursor: state.cursor, truncated: state.truncated,
            driverState: { ...m.entry.driverState, webhook: structuredClone(state) } };
          await this.persist(m, next);
          this.managed.delete(oldId); this.managed.set(next.id, m);
        }), onPending: id => this.options.onPending?.(id),
      });
      m.stop = () => client.unsubscribe(m.entry.id);
      m.suspend = () => client.suspend();
      m.rotate = signal => client.rotateSecret(m.entry.id, signal);
      if (restoring) {
        const state = this.restoredWebhook(entry);
        await client.restore([state], signal);
      } else await client.subscribe(entry.name, entry.arguments, { cursor: entry.cursor,
        ...(entry.maxAgeMs === undefined ? {} : { maxAgeMs: entry.maxAgeMs }), ...(ttlMs === undefined ? {} : { ttlMs }) }, signal);
    }
  }
  restore(signal?: AbortSignal): Promise<EventSubscription[]> {
    return this.serial(async () => {
      const prepared: Managed[] = [];
      const pendingOnly: string[] = [];
      try {
        // Check the complete restoration batch before starting any workers.
        for (const entry of this.options.registry.list()) {
          if (this.managed.has(entry.id)) continue;
          const state = privateState.parse(entry.driverState);
          const cleanup = entry.delivery === "webhook" && state.webhook?.cleanupPending === true;
          const terminal = ["failed", "stopped"].includes(entry.status) && !cleanup;
          if (terminal && !(await this.options.inbox.pending(this.scope(entry.id))).length) continue;
          const session = await this.options.connect(entry.server);
          try {
            if (!session.serverBinding || state.serverBinding !== session.serverBinding) throw new Error("Events restoration binding mismatch");
            if (terminal) { pendingOnly.push(entry.id); session.close(); continue; }
            const webhook = entry.delivery === "webhook" ? this.restoredWebhook(entry) : undefined;
            const descriptor = cleanup
              ? webhook!.descriptor
              : await this.descriptor(session, entry, signal);
            prepared.push(this.prepare(entry, session, descriptor));
          } catch (error) { session.close(); throw error; }
        }
        for (const m of prepared) {
          this.managed.set(m.entry.id, m);
          await this.launch(m, true, undefined, signal);
          if ((await this.options.inbox.pending(this.scope(m.entry.id))).length) await this.options.onPending?.(m.entry.id);
        }
        for (const id of pendingOnly) await this.options.onPending?.(id);
        return this.list();
      } catch (error) {
        for (const m of prepared) { m.stopping = true; await m.suspend(); m.detach(); await m.queue; this.managed.delete(m.entry.id); }
        throw error instanceof Error && /binding/.test(error.message) ? new Error("Events restoration binding mismatch") : new Error("Events restoration failed");
      }
    });
  }
  async pending(id?: string): Promise<PendingEventDelivery[]> {
    const entries = this.options.registry.list().filter(entry => !id || entry.id === id);
    if (id && !entries.length) throw new Error("Unknown Events subscription");
    const result: PendingEventDelivery[] = [];
    for (const entry of entries) for (const item of await this.options.inbox.pending(this.scope(entry.id)))
      result.push({ subscriptionId: entry.id, server: entry.server, id: item.id, delivery: item.delivery });
    return result;
  }
  /** The Pi integration calls this only after the associated agent turn finishes. */
  async acknowledge(deliveries: Array<{ subscriptionId: string; id: string }>): Promise<void> {
    const ids = new Set(this.options.registry.list().map(entry => entry.id));
    for (const row of deliveries) if (!ids.has(row.subscriptionId)) throw new Error("Unknown Events subscription");
    for (const row of deliveries) await this.options.inbox.acknowledge(this.scope(row.subscriptionId), row.id);
  }
  unsubscribe(id: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.options.registry.list().find(row => row.id === id);
      if (!entry) return;
      if (entry.status === "stopped" && (entry.delivery !== "webhook" ||
        privateState.parse(entry.driverState).webhook?.cleanupPending === false)) return;
      let m = this.managed.get(id);
      const stopped: Partial<StoredEventSubscription> = { status: "stopped" };
      if (entry.delivery === "webhook") stopped.driverState = { ...entry.driverState,
        webhook: { ...this.restoredWebhook(entry), status: "stopped", cleanupPending: true } };
      if (!m) {
        const saved = { ...entry, ...stopped };
        await this.options.registry.save(saved);
        this.notifyStatus(entry.status, saved);
        if (entry.delivery !== "webhook") return;
        const session = await this.options.connect(entry.server);
        try {
          if (!session.serverBinding || privateState.parse(saved.driverState).serverBinding !== session.serverBinding)
            throw new Error("Events restoration binding mismatch");
          m = this.prepare(saved, session, this.restoredWebhook(saved).descriptor);
          this.managed.set(id, m);
          await this.launch(m, true);
        } catch {
          throw new Error("Events unsubscribe failed; remote cleanup remains pending");
        } finally {
          if (m) { m.stopping = true; await m.suspend(); m.detach(); await m.queue; this.managed.delete(id); }
          else session.close();
        }
        return;
      }
      m.stopping = true;
      const active = m;
      await this.enqueue(active, () => this.save(active, stopped));
      try { await active.stop(); }
      catch { throw new Error("Events unsubscribe failed; remote cleanup remains pending"); }
      finally { await active.suspend(); active.detach(); await active.queue; this.managed.delete(id); }
    });
  }
  rotateSecret(id: string, signal?: AbortSignal): Promise<EventSubscription> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const m = this.managed.get(id);
      if (!m || m.stopping || m.entry.delivery !== "webhook" || !m.rotate)
        throw new Error("Active webhook subscription is required for rotation");
      await m.rotate(signal);
      return this.list().find(row => row.id === id)!;
    });
  }
  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    this.closed = true;
    this.closeFlight = this.operations.then(async () => {
      for (const m of this.managed.values()) m.stopping = true;
      for (const m of this.managed.values()) { await m.suspend(); m.detach(); await m.queue; }
      this.managed.clear();
    });
    return this.closeFlight;
  }
}
