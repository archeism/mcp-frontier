import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebhookEventsClient, type WebhookSubscriptionState } from "../mcp-events-webhook-client.ts";
import { WebhookReceiver } from "../mcp-events-webhook.ts";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";
import type { McpProtocolSession } from "../runtime-protocol.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.useRealTimers(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "webhook-lifecycle-"));
  const receiver = new WebhookReceiver(), inbox = new DurableWebhookInbox(join(root, "inbox"));
  const saved: WebhookSubscriptionState[] = [], calls: Array<{ method: string; params: any; at: number }> = [];
  let failure: unknown, cleanupFailure: unknown, hang = false, removed = false, noExpiry = false, omitCursor = false;
  let notify!: () => void;
  const controller = new AbortController();
  const session: McpProtocolSession = {
    signal: controller.signal, serverBinding: "original-binding", protocolVersion: "2026-07-28", serverCapabilities: { events: {} },
    getEventsCapabilities: async () => ({}),
    watchNotifications: (_methods, callback) => { notify = () => callback("notifications/events/list_changed", {}); return { close() {}, closed: new Promise(() => {}) }; },
    openStream: () => { throw new Error("No downgrade allowed"); }, close() {},
    request: async (method, params, signal) => {
      calls.push({ method, params: structuredClone(params), at: Date.now() });
      if (method === "events/list") return { events: removed ? [] : [{ name: "tick", delivery: ["webhook"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }] };
      if (method === "events/subscribe") {
        if (failure) throw failure;
        if (hang) await new Promise((_, reject) => (signal ?? controller.signal).addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        return { id: "remote", refreshBefore: noExpiry ? null : new Date(Date.now() + 10000).toISOString(), ...(omitCursor ? {} : { cursor: "watermark" }) };
      }
      if (method === "events/unsubscribe" && cleanupFailure) throw cleanupFailure;
      return {};
    },
  };
  const options = { receiver, inbox, callbackBaseUrl: "https://receiver.example/hooks", scope: "pi",
    save: async (state: WebhookSubscriptionState) => { saved.push(structuredClone(state)); }, onPending() {} };
  const client = new WebhookEventsClient("authenticated-server", session, options);
  cleanups.push(async () => { controller.abort(); await client.suspend(); await rm(root, { recursive: true, force: true }); });
  const post = async (body: object, key: string, id = "msg_verification_nonce", subscription = "remote") => {
    const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from(key.slice(6), "base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
    return receiver.handle(new Request(saved.at(-1)!.callbackUrl, { method: "POST", body: raw, headers: {
      "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": subscription,
    } }));
  };
  return { client, receiver, saved, calls, post, options, session, inbox,
    disconnect: () => controller.abort(),
    removeDescriptor: () => { removed = true; notify(); },
    restoreDescriptor: () => { removed = false; }, noExpiry: () => { noExpiry = true; },
    omitCursor: () => { omitCursor = true; },
    failure: (value: unknown) => { failure = value; }, cleanupFailure: (value: unknown) => { cleanupFailure = value; }, hang: () => { hang = true; } };
}

it("absent webhook grant and occurrence cursors clear the previous replay position to null", async () => {
  const f = await fixture(); f.omitCursor();
  const sub = await f.client.subscribe("tick", {}, { cursor: "old" });
  expect(sub.cursor).toBe(null); const key = f.saved.at(-1)!.secret;
  const event = { eventId: "with-cursor", name: "tick", timestamp: "2026-10-17T00:00:00Z", data: {}, cursor: "fresh" };
  expect((await f.post(event, key, event.eventId)).status).toBe(202);
  expect(f.client.status(sub.id)[0]!.cursor).toBe("fresh");
  const { cursor: _cursor, ...absent } = { ...event, eventId: "without-cursor" };
  expect((await f.post(absent, key, absent.eventId)).status).toBe(202);
  expect(f.client.status(sub.id)[0]!.cursor).toBe(null);
  await f.client.rotateSecret(sub.id);
  expect(f.calls.filter(c => c.method === "events/subscribe").at(-1)!.params.cursor).toBe(null);
});
it("no-expiry grant is opt-in and periodically refreshes both catalog and watermark", async () => {
  vi.useFakeTimers(); const f = await fixture(); f.noExpiry();
  await expect(f.client.subscribe("tick")).rejects.toThrow();
  const sub = await f.client.subscribe("tick", {}, { ttlMs: null });
  const before = f.calls.length;
  await vi.advanceTimersByTimeAsync(3600000 * 0.8);
  expect(f.calls.slice(before).map(c => c.method)).toEqual(["events/list", "events/subscribe"]);
  expect(f.client.status(sub.id)[0]).toMatchObject({ status: "active", refreshBefore: null, cursor: "watermark" });
});
it("a requested no-expiry lifetime accepts an authoritative finite grant", async () => {
  const f = await fixture(); const sub = await f.client.subscribe("tick", {}, { ttlMs: null });
  expect(sub.refreshBefore).not.toBe(null); expect(sub.status).toBe("active");
});

it("retries transient renewal before the grant deadline with backoff and the unchanged tuple", async () => {
  vi.useFakeTimers(); const f = await fixture();
  const sub = await f.client.subscribe("tick", { nested: { z: 2, a: 1 } });
  f.failure(new Error("temporary transport failure"));
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.client.status(sub.id)[0]!.status).toBe("reconnecting");
  expect(f.calls.filter(c => c.method === "events/subscribe")).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.calls.filter(c => c.method === "events/subscribe")).toHaveLength(2);
  f.failure(undefined); await vi.advanceTimersByTimeAsync(500);
  const attempts = f.calls.filter(c => c.method === "events/subscribe");
  expect(attempts).toHaveLength(3);
  expect(attempts[2]!.params).toEqual({ ...attempts[0]!.params, cursor: "watermark" });
  expect(f.client.status(sub.id)[0]!.status).toBe("active");
});
it("stops accepting deliveries at refreshBefore even while renewal hangs", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  const original = f.saved.at(-1)!; f.hang();
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.client.status(sub.id)[0]).toMatchObject({ status: "failed", cleanupPending: true });
  expect((await f.post({ type: "verification", challenge: "nonce" }, original.secret)).status).toBe(404);
});
it("does not retry or downgrade a Forbidden renewal", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  f.failure({ code: -32024, message: "Forbidden" }); await vi.advanceTimersByTimeAsync(20000);
  expect(f.client.status(sub.id)[0]!.status).toBe("failed");
  expect(f.calls.filter(c => c.method === "events/subscribe")).toHaveLength(2);
  expect(f.calls.every(c => ["events/list", "events/subscribe"].includes(c.method))).toBe(true);
});
it("rotates a generated secret on the same subscription tuple without exposing it", async () => {
  const f = await fixture(); const sub = await f.client.subscribe("tick", { z: 1, a: { b: 2 } });
  const old = f.saved.at(-1)!.secret;
  const result = await f.client.rotateSecret(sub.id);
  const current = f.saved.at(-1)!.secret;
  expect(current).not.toBe(old);
  const attempts = f.calls.filter(c => c.method === "events/subscribe");
  expect(attempts[1]!.params).toEqual({ ...attempts[0]!.params, cursor: "watermark", delivery: { ...attempts[0]!.params.delivery, secret: current } });
  expect(JSON.stringify([result, f.client.status()])).not.toContain("whsec_");
  expect((await f.post({ type: "verification", challenge: "nonce" }, current)).status).toBe(200);
  expect((await f.post({ type: "verification", challenge: "nonce" }, old)).status).toBe(401);
});
it("keeps an uncertain rotation durable and retries the same new secret", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  const old = f.saved.at(-1)!.secret; f.failure(new Error("timeout with unknown result"));
  await expect(f.client.rotateSecret(sub.id)).rejects.toThrow("rotation");
  const pending = f.calls.filter(c => c.method === "events/subscribe").at(-1)!.params.delivery.secret;
  expect(pending).not.toBe(old);
  expect(JSON.stringify(f.saved.at(-1))).toContain(pending);
  expect(JSON.stringify(f.client.status())).not.toContain("whsec_");
  f.failure(undefined); await vi.advanceTimersByTimeAsync(1000);
  expect(f.calls.filter(c => c.method === "events/subscribe").at(-1)!.params.delivery.secret).toBe(pending);
  expect(f.saved.at(-1)!.secret).toBe(pending);
});
it("restores an uncertain rotation using the durable replacement and original tuple", async () => {
  const f = await fixture(); const sub = await f.client.subscribe("tick", { nested: { b: 2, a: 1 } });
  f.failure(new Error("lost refresh response"));
  await expect(f.client.rotateSecret(sub.id)).rejects.toThrow("rotation");
  const checkpoint = structuredClone(f.saved.at(-1)!);
  const pending = f.calls.filter(c => c.method === "events/subscribe").at(-1)!.params.delivery.secret;
  await f.client.suspend(); f.failure(undefined);
  const restored = new WebhookEventsClient("authenticated-server", f.session, f.options);
  try {
    await restored.restore([checkpoint]);
    expect(f.calls.filter(c => c.method === "events/subscribe").at(-1)!.params).toMatchObject({
      name: checkpoint.name, arguments: checkpoint.arguments, delivery: { url: checkpoint.callbackUrl, secret: pending },
    });
    expect(JSON.stringify(restored.status())).not.toContain("whsec_");
    expect((await f.post({ type: "verification", challenge: "restored" }, pending)).status).toBe(200);
  } finally { await restored.suspend(); }
});
it.each([undefined, {}, { kind: "subscription" }])("finishes eager cleanup for contextual NotFound with optional data.kind: %j", async data => {
  const f = await fixture(); const sub = await f.client.subscribe("tick");
  f.cleanupFailure({ code: -32023, ...(data === undefined ? {} : { data }) });
  await expect(f.client.unsubscribe(sub.id)).resolves.toEqual({ stopped: true });
  expect(f.saved.at(-1)!.cleanupPending).toBe(false);
});
it("does not clear cleanup intent on authorization failure", async () => {
  const f = await fixture(); const sub = await f.client.subscribe("tick");
  f.cleanupFailure({ code: -32024 });
  await expect(f.client.unsubscribe(sub.id)).rejects.toBeDefined();
  expect(f.saved.at(-1)).toMatchObject({ status: "stopped", cleanupPending: true });
  expect((await f.post({ type: "verification", challenge: "stopped" }, f.saved.at(-1)!.secret)).status).toBe(404);
});
it.each([{ kind: "event" }, { kind: null }, null, []])("does not reinterpret contradictory/malformed unsubscribe NotFound data: %j", async data => {
  const f = await fixture(); const sub = await f.client.subscribe("tick");
  f.cleanupFailure({ code: -32023, data });
  await expect(f.client.unsubscribe(sub.id)).rejects.toBeDefined();
  expect(f.saved.at(-1)!.cleanupPending).toBe(true);
});
it("treats an absent gap cursor as null and forwards signed termination", async () => {
  const f = await fixture(); const sub = await f.client.subscribe("tick");
  const key = f.saved.at(-1)!.secret;
  expect((await f.post({ type: "gap" }, key, "msg_gap_nonce")).status).toBe(202);
  expect(f.client.status(sub.id)[0]!.cursor).toBe(null);
  expect((await f.post({ type: "terminated", error: { code: -32024, message: "Forbidden" } }, key, "msg_terminated_nonce")).status).toBe(202);
  expect(f.client.status(sub.id)[0]).toMatchObject({ status: "failed", cleanupPending: false });
  expect((await f.inbox.pending(`pi/${sub.id}`)).map(row => row.id).sort()).toEqual(["msg_gap_nonce", "msg_terminated_nonce"]);
});
it("eager cleanup cancels a hung renewal instead of waiting forever with its deadline cleared", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  f.hang(); await vi.advanceTimersByTimeAsync(8000);
  let stopped = false;
  const cleanup = f.client.unsubscribe(sub.id).then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(1);
  expect(stopped).toBe(true);
  await cleanup;
  expect(f.saved.at(-1)).toMatchObject({ status: "stopped", cleanupPending: false });
});
it("retries a restored live grant after a transient renewal failure", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  const checkpoint = structuredClone(f.saved.at(-1)!);
  await f.client.suspend(); f.failure(new Error("temporary disconnect"));
  const restored = new WebhookEventsClient("authenticated-server", f.session, f.options);
  try {
    expect((await restored.restore([checkpoint]))[0]!.status).toBe("reconnecting");
    f.failure(undefined); await vi.advanceTimersByTimeAsync(1000);
    expect(restored.status(sub.id)[0]!.status).toBe("active");
  } finally { await restored.suspend(); }
});
for (const field of ["secret", "pendingSecret"] as const) {
  it.each(["invalid", "", null, 0, {}])(`validates every restored ${field} before installing or cleaning any batch member: %j`, async invalid => {
    const f = await fixture(); await f.client.subscribe("tick");
    const first = structuredClone(f.saved.at(-1)!); await f.client.suspend();
    const id = randomUUID(), second = { ...first, id, callbackUrl: f.options.callbackBaseUrl + "/" + id,
      [field]: invalid, status: "stopped", cleanupPending: true } as unknown as WebhookSubscriptionState;
    const restored = new WebhookEventsClient("authenticated-server", f.session, f.options);
    const before = f.calls.filter(c => c.method !== "events/list").length;
    try {
      await expect(restored.restore([first, second])).rejects.toThrow();
      expect(f.calls.filter(c => c.method !== "events/list")).toHaveLength(before);
      expect(restored.status()).toEqual([]);
      expect((await f.receiver.handle(new Request(second.callbackUrl))).status).toBe(404);
      expect((await f.receiver.handle(new Request(first.callbackUrl))).status).toBe(404);
    } finally { await restored.suspend(); }
  });
}
it("rolls back a newly registered route when its later activation throws", async () => {
  const f = await fixture(); await f.client.subscribe("tick");
  const state = structuredClone(f.saved.at(-1)!); await f.client.suspend();
  const register = f.receiver.register.bind(f.receiver);
  vi.spyOn(f.receiver, "register").mockImplementationOnce(options => ({ ...register(options), activate() { throw new Error("activation failed"); } }));
  const restored = new WebhookEventsClient("authenticated-server", f.session, f.options);
  try {
    await expect(restored.restore([state])).rejects.toThrow("activation failed");
    expect((await f.receiver.handle(new Request(state.callbackUrl))).status).toBe(404);
    expect(restored.status()).toEqual([]);
  } finally { await restored.suspend(); }
});
it.each(["gap", "terminated"] as const)("forwards signed %s controls despite descriptor removal without fetching its catalog", async type => {
  const f = await fixture(); const sub = await f.client.subscribe("tick"), key = f.saved.at(-1)!.secret;
  f.removeDescriptor();
  const before = f.calls.filter(c => c.method === "events/list").length;
  const body = type === "gap" ? { type, cursor: "fresh" } : { type, error: { code: -32023, message: "NotFound", data: { kind: "event" } } };
  expect((await f.post(body, key, `msg_${type}_nonce`)).status).toBe(202);
  expect(f.calls.filter(c => c.method === "events/list")).toHaveLength(before);
  expect((await f.inbox.pending(`pi/${sub.id}`)).map(row => row.id)).toContain(`msg_${type}_nonce`);
  if (type === "terminated") expect(f.client.status(sub.id)[0]).toMatchObject({ status: "reconnecting", cleanupPending: false });
  else {
    expect(f.client.status(sub.id)[0]!.cursor).toBe("fresh");
    expect((await f.post({ eventId: "obsolete", name: "tick", timestamp: new Date().toISOString(), data: {} }, key, "obsolete")).status).toBe(503);
  }
});
it("reconnects a dropped mediated session and renews with the same secret, tuple and watermark", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick", { nested: { b: 2, a: 1 } });
  const first = f.calls.find(c => c.method === "events/subscribe")!.params;
  const next = { ...f.session, signal: new AbortController().signal };
  const reconnect = vi.fn(async () => next); Object.assign(f.options, { reconnect });
  f.disconnect(); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.status(sub.id)[0]!.status).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(1000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  expect(f.client.session).toBe(next);
  expect(f.calls.filter(c => c.method === "events/subscribe").at(-1)!.params).toEqual({ ...first, cursor: "watermark" });
  expect(f.client.status(sub.id)[0]!.status).toBe("active");
});
it("backs off transient session-factory failures without losing the finite grant deadline", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  const next = { ...f.session, signal: new AbortController().signal };
  const reconnect = vi.fn().mockRejectedValueOnce(new Error("temporarily offline")).mockResolvedValue(next);
  Object.assign(f.options, { reconnect }); f.disconnect();
  await vi.advanceTimersByTimeAsync(1000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  expect(f.client.status(sub.id)[0]!.status).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(2000);
  expect(reconnect).toHaveBeenCalledTimes(2);
  expect(f.client.status(sub.id)[0]!.status).toBe("active");
});
it("closes a differently bound replacement without sending it a signing secret", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  const request = vi.fn(), close = vi.fn();
  const next = { ...f.session, signal: new AbortController().signal, serverBinding: "different-binding", request, close };
  Object.assign(f.options, { reconnect: async () => next }); f.disconnect();
  await vi.advanceTimersByTimeAsync(1000);
  expect(close).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  expect(f.client.status(sub.id)[0]).toMatchObject({ status: "failed", cleanupPending: true });
});
it("closes a replacement arriving after suspension instead of reviving the receiver", async () => {
  vi.useFakeTimers(); const f = await fixture(); await f.client.subscribe("tick");
  let release!: (session: McpProtocolSession) => void;
  Object.assign(f.options, { reconnect: () => new Promise<McpProtocolSession>(resolve => { release = resolve; }) });
  f.disconnect(); await vi.advanceTimersByTimeAsync(1000);
  await f.client.suspend();
  const close = vi.fn(), request = vi.fn();
  release({ ...f.session, signal: new AbortController().signal, close, request });
  await vi.advanceTimersByTimeAsync(0);
  expect(close).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  expect((await f.receiver.handle(new Request(f.saved.at(-1)!.callbackUrl))).status).toBe(404);
});
it.each([
  { code: -32023, message: "NotFound" },
  { code: -32023, message: "NotFound", data: {} },
  { code: -32023, message: "NotFound", data: { kind: "event" } },
  { code: -32026, message: "Unsupported", data: { reason: "schema_changed", feature: "inputSchema" } },
  { code: -32026, message: "Unsupported", data: { reason: "schema_changed", feature: "payloadSchema" } },
])("rediscover/resubscribe after signed termination code $code / $data", async error => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick"), key = f.saved.at(-1)!.secret;
  const original = f.calls.find(c => c.method === "events/subscribe")!.params;
  expect((await f.post({ type: "terminated", error }, key, "msg_terminated_schema")).status).toBe(202);
  expect(f.client.status(sub.id)[0]!.status).toBe("reconnecting");
  const catalogs = f.calls.filter(c => c.method === "events/list").length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.calls.filter(c => c.method === "events/list").length).toBeGreaterThan(catalogs);
  expect(f.calls.filter(c => c.method === "events/subscribe")).toHaveLength(2);
  expect(f.calls.filter(c => c.method === "events/subscribe").at(-1)!.params).toEqual({ ...original, cursor: "watermark" });
  expect(f.client.status(sub.id)[0]!.status).toBe("active");
  expect((await f.inbox.pending(`pi/${sub.id}`)).map(row => row.id)).toContain("msg_terminated_schema");
});
it("bounds rediscovery retries for a removed no-expiry event instead of spinning forever", async () => {
  vi.useFakeTimers(); const f = await fixture(); f.noExpiry();
  const sub = await f.client.subscribe("tick", {}, { ttlMs: null }), key = f.saved.at(-1)!.secret;
  f.removeDescriptor();
  expect((await f.post({ type: "terminated", error: { code: -32023, message: "NotFound", data: { kind: "event" } } }, key, "msg_terminated_removed")).status).toBe(202);
  expect(f.client.status(sub.id)[0]!.status).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.client.status(sub.id)[0]!.status).toBe("failed");
  expect(f.calls.filter(c => c.method === "events/list").length).toBeLessThanOrEqual(7);
  expect(f.calls.filter(c => c.method === "events/subscribe")).toHaveLength(1);
});
it("keeps the callback live while MCP is down and recovers a no-expiry grant", async () => {
  vi.useFakeTimers(); const f = await fixture(); f.noExpiry();
  const sub = await f.client.subscribe("tick", {}, { ttlMs: null }), key = f.saved.at(-1)!.secret;
  const reconnect = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...f.session, signal: new AbortController().signal });
  Object.assign(f.options, { reconnect }); f.disconnect(); await vi.advanceTimersByTimeAsync(1000);
  expect((await f.post({ eventId: "during-outage", name: "tick", timestamp: new Date().toISOString(), data: {}, cursor: "outage-cursor" }, key, "during-outage")).status).toBe(202);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.client.status(sub.id)[0]!.status).toBe("active");
  expect(f.calls.filter(c => c.method === "events/subscribe").at(-1)!.params.cursor).toBe("outage-cursor");
  expect(f.saved.at(-1)!.refreshBefore).toBe(null);
});
it.each([
  { code: -32024, message: "Forbidden" },
  { code: -32023, message: "NotFound", data: { kind: "subscription" } },
  { code: -32026, message: "Unsupported", data: { reason: "schema_changed", feature: "deliveryMode" } },
  { code: -32026, message: "Unsupported", data: { reason: "other", feature: "payloadSchema" } },
])("does not rediscover unapproved termination code/data: %j", async error => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick"), key = f.saved.at(-1)!.secret;
  const before = f.calls.length;
  expect((await f.post({ type: "terminated", error }, key, "msg_terminated_stop")).status).toBe(202);
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.calls).toHaveLength(before);
  expect(f.client.status(sub.id)[0]!.status).toBe("failed");
});
it("keeps a finite callback live without a replacement factory until its grant expires", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick"), key = f.saved.at(-1)!.secret;
  f.disconnect(); await vi.advanceTimersByTimeAsync(9000);
  expect((await f.post({ type: "gap", cursor: "offline-watermark" }, key, "msg_gap_offline")).status).toBe(202);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.client.status(sub.id)[0]!.status).toBe("failed");
  expect((await f.post({ type: "verification", challenge: "expired" }, key)).status).toBe(404);
});
it("stops rather than retries a Forbidden response coinciding with MCP disconnection", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  const original = f.session.request.bind(f.session);
  f.session.request = async (method, params, signal) => {
    if (method === "events/subscribe") { f.disconnect(); throw { code: -32024, message: "Forbidden" }; }
    return original(method, params, signal);
  };
  const reconnect = vi.fn(); Object.assign(f.options, { reconnect });
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.client.status(sub.id)[0]!.status).toBe("failed");
  expect(reconnect).not.toHaveBeenCalled();
});
it("replaces a live-looking mediated session after a fetch transport failure", async () => {
  vi.useFakeTimers(); const f = await fixture(); const sub = await f.client.subscribe("tick");
  const original = f.session.request.bind(f.session);
  f.session.request = async (method, params, signal) => {
    if (method === "events/subscribe") throw new TypeError("fetch failed");
    return original(method, params, signal);
  };
  const next = { ...f.session, signal: new AbortController().signal, request: original };
  const reconnect = vi.fn(async () => next); Object.assign(f.options, { reconnect });
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.session.signal.aborted).toBe(false);
  expect(reconnect).toHaveBeenCalledOnce();
  expect(f.client.status(sub.id)[0]!.status).toBe("active");
});
