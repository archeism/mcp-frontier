import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { JsonSchemaValidator } from "@modelcontextprotocol/client";
import { createJsonSchemaValidator } from "./json-schema-validator.ts";
import { readEventCapability, type McpProtocolSession } from "./runtime-protocol.ts";
import { abortable } from "./abort.ts";
import { UnauthorizedError, InsufficientScopeError } from "@modelcontextprotocol/client";

// Experimental WG design sketch, read 2026-10-16:
// https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
export const POLL_EVENTS_PROTOCOL = {
  namespace: "event_delivery", requests: ["events/list", "events/poll"], streams: [],
  notifications: ["notifications/events/list_changed"],
};
const object = z.record(z.string(), z.unknown());
const cursor = z.string().max(8192).nullable().optional();
const descriptor = z.object({ name: z.string().min(1).max(256), description: z.string().max(8192).optional(),
  delivery: z.array(z.enum(["poll", "push", "webhook"])).min(1).max(3), inputSchema: object, payloadSchema: object });
const occurrence = z.object({ eventId: z.string().min(1).max(1024), name: z.string().min(1).max(256),
  timestamp: z.iso.datetime({ offset: true }), data: object });
const pollResult = z.object({ events: z.array(occurrence).max(50), cursor,
  truncated: z.boolean().optional(), hasMore: z.boolean().optional(), nextPollMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
type Descriptor = z.infer<typeof descriptor>;
export interface PollSubscription {
  id: string; server: string; name: string; arguments: Record<string, unknown>; cursor: string | null;
  status: "active" | "reconnecting" | "stopped" | "failed"; nextPollAt: number; delivered: number; duplicates: number;
  truncated: boolean; error?: string;
}
interface Item {
  state: PollSubscription; descriptor: Descriptor; payload: JsonSchemaValidator<unknown>;
  controller: AbortController; timer?: ReturnType<typeof setTimeout>; flight?: Promise<void>;
  seen: Set<string>; dirty: boolean; detach(): void;
  maxAgeMs?: number;
  retries: number; needsReconnect: boolean;
}
export interface PollEventsRecoveryOptions {
  reconnect?: () => Promise<McpProtocolSession>;
  retryBaseMs?: number; maxRetries?: number;
}
const running = (item: Item) => item.state.status === "active" || item.state.status === "reconnecting";
function recoverable(error: unknown) {
  if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError) return false;
  const value = error as { code?: unknown; status?: unknown; data?: { reason?: unknown } } | undefined;
  if (value?.status === 401 || value?.status === 403) return false;
  if (typeof value?.code === "number") return [-32603, -32023, -32025].includes(value.code) ||
    (value.code === -32026 && value.data?.reason === "schema_changed");
  return error instanceof Error && !(error instanceof z.ZodError);
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const bounded = (value: unknown, maximum: number) => {
  if (bytes(value) > maximum) throw new Error("MCP Events response exceeds the bounded delivery budget");
  return value;
};

/** Polling stays below the model: one sequential loop per session-local subscription. */
export class PollEventsClient {
  private items = new Map<string, Item>();
  private closed = false;
  private validator = createJsonSchemaValidator();
  private reconnecting: Promise<void> | undefined;
  constructor(readonly server: string, public session: McpProtocolSession,
    private deliver: (body: unknown) => void | Promise<void>, private floorMs = 1000,
    private recovery: PollEventsRecoveryOptions = {}) {
    if (!Number.isSafeInteger(floorMs) || floorMs < 1) throw new Error("Positive polling floor required");
  }
  async list(signal?: AbortSignal): Promise<Descriptor[]> {
    const capability = await readEventCapability(this.session, signal);
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) throw new Error("Server does not declare events capability");
    const entries: Descriptor[] = [], names = new Set<string>(), cursors = new Set<string>();
    let next: string | undefined;
    for (let page = 0; page < 100; page++) {
      const raw = bounded(await this.session.request("events/list", next ? { cursor: next } : {}, signal), 256 * 1024);
      const result = z.object({ events: z.array(descriptor).max(256), nextCursor: z.string().min(1).max(8192).optional() }).parse(raw);
      for (const entry of result.events) {
        if (names.has(entry.name) || entries.length >= 256) throw new Error("Duplicate or excessive event catalog");
        this.validator.getValidator(entry.inputSchema); this.validator.getValidator(entry.payloadSchema);
        names.add(entry.name); entries.push(entry);
      }
      if (!result.nextCursor) return entries;
      if (cursors.has(result.nextCursor)) throw new Error("Repeated event catalog cursor");
      cursors.add(result.nextCursor); next = result.nextCursor;
    }
    throw new Error("Event catalog pagination limit exceeded");
  }
  status(id?: string): PollSubscription[] {
    if (id && !this.items.has(id)) throw new Error("Unknown poll subscription");
    return [...this.items.values()].filter(item => !id || item.state.id === id).map(item => structuredClone(item.state));
  }
  async subscribe(name: string, args: Record<string, unknown> = {}, initialCursor: string | null = null,
    maxAgeMs?: number, signal?: AbortSignal): Promise<PollSubscription> {
    if (this.closed || this.session.signal.aborted) throw new Error("Events session ended");
    signal?.throwIfAborted();
    if (this.items.size >= 32) throw new Error("Poll subscription limit reached; unsubscribe first");
    cursor.parse(initialCursor);
    if (maxAgeMs !== undefined && (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0)) throw new Error("Invalid maxAgeMs");
    bounded(args, 32768);
    const entry = (await this.list(signal)).find(entry => entry.name === name);
    if (!entry?.delivery.includes("poll")) throw new Error("Event does not advertise poll delivery");
    const input = this.validator.getValidator(entry.inputSchema)(args);
    if (!input.valid) throw new Error("Event arguments do not match inputSchema");
    if (this.closed || this.session.signal.aborted) throw new Error("Events session ended");
    signal?.throwIfAborted();
    if (this.items.size >= 32) throw new Error("Poll subscription limit reached");
    const state: PollSubscription = { id: randomUUID(), server: this.server, name, arguments: structuredClone(args),
      cursor: initialCursor, status: "active", nextPollAt: 0, delivered: 0, duplicates: 0, truncated: false };
    const controller = new AbortController();
    const item: Item = { state, descriptor: entry, payload: this.validator.getValidator(entry.payloadSchema),
      controller, seen: new Set(), dirty: false, detach() {}, retries: 0, needsReconnect: false, ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    };
    this.bind(item);
    this.items.set(state.id, item);
    const cancelled = () => this.stop(item, "stopped");
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      await this.run(item);
      if (!running(item)) throw new Error(state.error ?? "Poll subscription cancelled");
      return structuredClone(state);
    } finally { signal?.removeEventListener("abort", cancelled); }
  }
  private bind(item: Item) {
    item.detach();
    const session = this.session;
    // The declared notification watch pins the connection during polling intervals.
    const watch = session.watchNotifications(POLL_EVENTS_PROTOCOL.notifications, () => { item.dirty = true; });
    const disconnected = () => { void this.retry(item, new Error("MCP connection ended")).then(async retry => {
      if (!retry && running(item)) {
        this.stop(item, "failed", "MCP connection ended");
        await this.deliver({ server: this.server, subscription_id: item.state.id, delivery: "poll", status: "failed" });
      }
    }).catch(() => this.stop(item, "failed", "Events recovery failed")); };
    session.signal.addEventListener("abort", disconnected, { once: true });
    item.detach = () => { watch.close(); session.signal.removeEventListener("abort", disconnected); };
  }
  private async retry(item: Item, error: unknown): Promise<boolean> {
    if (this.closed || !running(item) || !this.recovery.reconnect || !recoverable(error)) return false;
    if (item.needsReconnect) return true;
    if (item.retries >= (this.recovery.maxRetries ?? 5)) return false;
    item.needsReconnect = true; item.state.status = "reconnecting"; item.detach();
    item.state.nextPollAt = Date.now() + Math.min(30000, (this.recovery.retryBaseMs ?? 1000) * 2 ** item.retries++);
    await this.deliver({ server: this.server, subscription_id: item.state.id, delivery: "poll", status: "reconnecting" });
    this.schedule(item); return true;
  }
  private async reconnect() {
    if (this.reconnecting) return this.reconnecting;
    const old = this.session;
    this.reconnecting = (async () => {
      const next = await this.recovery.reconnect!();
      if (this.closed || !old.serverBinding || next.serverBinding !== old.serverBinding) { next.close(); throw new Error("Events reconnect binding mismatch"); }
      this.session = next;
      for (const item of this.items.values()) if (running(item)) { this.bind(item); item.dirty = true; }
      old.close();
    })().finally(() => { this.reconnecting = undefined; });
    return this.reconnecting;
  }
  private stop(item: Item, status: "stopped" | "failed", error?: string) {
    if (!running(item)) return;
    item.state.status = status;
    if (error) item.state.error = error.slice(0, 2048);
    clearTimeout(item.timer); item.controller.abort(); item.detach();
  }
  private schedule(item: Item) {
    if (!running(item) || this.closed) return;
    // Long server intervals must not overflow Node's timer and become a 1ms spin.
    item.timer = setTimeout(() => {
      if (Date.now() < item.state.nextPollAt) this.schedule(item);
      else void this.run(item);
    }, Math.min(2147483647, Math.max(0, item.state.nextPollAt - Date.now())));
    item.timer.unref?.();
  }
  private run(item: Item): Promise<void> {
    if (item.flight) return item.flight;
    if (!running(item) || this.closed) return Promise.resolve();
    clearTimeout(item.timer);
    item.flight = (async () => {
      let requestFailed = false;
      try {
        if (item.needsReconnect) {
          item.needsReconnect = false;
          try { await this.reconnect(); } catch (error) { requestFailed = true; throw error; }
        }
        if (item.dirty) {
          item.dirty = false;
          const entry = (await this.list(item.controller.signal)).find(entry => entry.name === item.state.name);
          if (!entry?.delivery.includes("poll") || !this.validator.getValidator(entry.inputSchema)(item.state.arguments).valid)
            throw new Error("Event descriptor no longer permits this subscription");
          item.descriptor = entry; item.payload = this.validator.getValidator(entry.payloadSchema);
        }
        const previous = item.state.cursor;
        let raw: unknown;
        try { raw = await this.session.request("events/poll", {
          name: item.state.name, arguments: item.state.arguments, cursor: previous, maxEvents: 50,
          ...(item.maxAgeMs === undefined ? {} : { maxAgeMs: item.maxAgeMs }),
        }, item.controller.signal); } catch (error) { requestFailed = true; throw error; }
        const result = pollResult.parse(bounded(raw, 256 * 1024));
        if (item.controller.signal.aborted || this.closed) return;
        for (const event of result.events) {
          bounded(event, 24000);
          if (event.name !== item.state.name || !item.payload(event.data).valid) throw new Error("Event payload does not match its declared name/payloadSchema");
        }
        const nextCursor = result.cursor ?? null;
        if (result.hasMore && (nextCursor === null || nextCursor === previous)) throw new Error("Backlog pagination did not advance its cursor");
        const accepted = new Set(item.seen);
        const fresh: typeof result.events = [];
        let duplicates = 0;
        for (const event of result.events) {
          if (accepted.has(event.eventId)) { duplicates++; continue; }
          accepted.add(event.eventId); fresh.push(event);
          if (accepted.size > 2048) accepted.delete(accepted.values().next().value!);
        }
        // Acceptance must see retries too: an existing ID can hide a payload
        // conflict. The seen set tracks counts, never bypasses the durable sink.
        // Empty pages still checkpoint without advancing before acceptance.
        await this.deliver({ server: this.server, subscription_id: item.state.id, delivery: "poll",
          events: result.events, cursor: nextCursor, truncated: !!result.truncated && nextCursor !== null });
        if (item.controller.signal.aborted || this.closed) return;
        item.seen = accepted;
        item.state.cursor = nextCursor;
        item.state.truncated ||= !!result.truncated && nextCursor !== null;
        item.state.duplicates += duplicates; item.state.delivered += fresh.length;
        item.retries = 0; item.state.status = "active"; delete item.state.error;
        // Drain a bounded backlog without honoring the idle/rate-limit hint.
        // Retain the configured safety floor against a malicious infinite backlog.
        item.state.nextPollAt = Date.now() + (result.hasMore ? this.floorMs : Math.max(this.floorMs, result.nextPollMs));
      } catch (error) {
        if (item.controller.signal.aborted || this.closed) return;
        if (requestFailed && await this.retry(item, error)) return;
        this.stop(item, "failed", String(error));
        try { await this.deliver({ server: this.server, subscription_id: item.state.id, delivery: "poll", status: "failed", error: item.state.error }); }
        catch { /* The failed sink must not become an unhandled background rejection. */ }
      } finally { delete item.flight; this.schedule(item); }
    })();
    return item.flight;
  }
  async poll(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const item = this.items.get(id);
    if (!item) throw new Error("Unknown poll subscription");
    // An explicit tool call cannot override the server's rate-limit interval.
    if (Date.now() >= item.state.nextPollAt) await abortable(this.run(item), signal);
    return this.status(id)[0]!;
  }
  unsubscribe(id: string) {
    const item = this.items.get(id);
    if (item) { this.stop(item, "stopped"); this.items.delete(id); }
    return { stopped: true };
  }
  close() {
    this.closed = true;
    for (const item of this.items.values()) this.stop(item, "stopped");
    this.items.clear(); this.session.close();
  }
}

