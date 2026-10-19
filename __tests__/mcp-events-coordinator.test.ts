import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { EventsRegistry } from "../mcp-events-registry.ts";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";
import { WebhookReceiver } from "../mcp-events-webhook.ts";
import { EventsCoordinator, EVENTS_COORDINATOR_PROTOCOL } from "../mcp-events-coordinator.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "events-coordinator-"));
  const receiver = new WebhookReceiver();
  const log: any[] = [];
  let invalidPayload = false, rejectWebhook = false, reportDeliveryStatus = false;
  let recoveringPoll = false, pollFailed = false;
  let terminatePush: number | undefined, pushRequests = 0;
  let renewalFailure: false | "http" | "socket" = false, subscribeRequests = 0;
  const connections: McpProtocolSession[] = [];
  const grants = new Map<string, any>();
  const names = { all: ["webhook", "push", "poll"], poll: ["poll"], push: ["push"], webhook: ["webhook"] };
  const occurrence = (name: string) => ({ eventId: "e1", name, timestamp: "2026-10-16T14:00:00Z", data: { value: invalidPayload ? "bad" : 42 } });
  async function post(params: any, body: object, id: string) {
    const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from(params.delivery.secret.slice(6), "base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
    return receiver.handle(new Request(params.delivery.url, { method: "POST", body: raw, headers: {
      "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": "remote-sub",
    } }));
  }
  const http = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); log.push(request);
    const result = (body: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: { resultType: "complete", ttlMs: 0, cacheScope: "private", ...body } }));
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const p = request.params;
    if (request.method === "server/discover") return result({ supportedVersions: ["2026-07-28"], capabilities: { events: {} } });
    if (request.method === "events/list") return result({ events: Object.entries(names).map(([name, delivery]) => ({ name, delivery,
      inputSchema: { type: "object", additionalProperties: false }, payloadSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } })) });
    if (request.method === "events/poll") {
      if (recoveringPoll && p.cursor && !pollFailed) { pollFailed = true; res.writeHead(503).end("Temporary fixture outage"); return; }
      return result({ events: p.cursor ? [occurrence(p.name)] : [], cursor: p.cursor ? "c2" : "c1", nextPollMs: recoveringPoll ? 1 : 60000 });
    }
    if (request.method === "events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (method: string, body: object) => res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method,
        params: { ...body, _meta: { "io.modelcontextprotocol/subscriptionId": request.id } } })}\n\n`);
      send("notifications/events/active", { cursor: "c1" });
      if (++pushRequests === 1 && terminatePush !== undefined) {
        send("notifications/events/terminated", { error: { code: terminatePush, message: "Fixture subscription changed",
          data: terminatePush === -32026 ? { feature: "payloadSchema", reason: "schema_changed" } : {} } });
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n\n`); return;
      }
      send("notifications/events/event", { ...occurrence(p.name), cursor: "c2" });
      return;
    }
    if (request.method === "events/subscribe") {
      if (renewalFailure && ++subscribeRequests === 2) {
        if (renewalFailure === "socket") req.socket.destroy(); else res.writeHead(503).end("Temporary renewal outage");
        return;
      }
      if (rejectWebhook) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32024, message: "Forbidden" } })); return; }
      const challenge = await post(p, { type: "verification", challenge: "nonce" }, "msg_verification_1");
      if (challenge.status !== 200) throw new Error("Challenge failed");
      grants.set(p.name, p);
      return result({ id: "remote-sub", refreshBefore: new Date(Date.now() + (renewalFailure ? 2000 : 3600000)).toISOString(), cursor: "c1",
        ...(reportDeliveryStatus ? { deliveryStatus: { active: false, lastError: "http_5xx", throttled: true, retryAfterMs: 60000,
          secret: "private-status-extension-DO-NOT-EXPOSE" } } : {}) });
    }
    if (request.method === "events/unsubscribe") return result({});
    return result({ tools: [] });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const manager = new McpServerManager(process.cwd());
  const owner = new AbortController();
  let registry = await EventsRegistry.open(join(root, "registry"), "session-one");
  const inbox = new DurableWebhookInbox(join(root, "inbox"));
  const notices: string[] = [];
  const connect = async (server: string) => { const session = createProtocolSession(await manager.connect(server, {
    url: `http://127.0.0.1:${address.port}/mcp`, auth: false, protocolVersion: "2026-07-28", tasks: false,
  }), owner.signal, EVENTS_COORDINATOR_PROTOCOL, server); connections.push(session); return session; };
  const coordinators: EventsCoordinator[] = [];
  const make = (webhook = false, supplied = connect) => {
    const coordinator = new EventsCoordinator({ sessionId: "session-one", registry, inbox, connect: supplied,
      onPending: id => { notices.push(id); },
      ...(webhook ? { webhook: { receiver, callbackBaseUrl: "https://receiver.example/hooks" } } : {}) });
    coordinators.push(coordinator); return coordinator;
  };
  return { root, log, notices, inbox, receiver, make, connect, registry: () => registry,
    invalid: () => { invalidPayload = true; }, forbid: () => { rejectWebhook = true; },
    reportDeliveryStatus: () => { reportDeliveryStatus = true; },
    recoverPoll: () => { recoveringPoll = true; },
    terminatePush: (code: number) => { terminatePush = code; },
    recoverWebhook: (kind: "http" | "socket") => { renewalFailure = kind; }, connects: () => connections.length,
    emit: async (name: string) => post(grants.get(name), { ...occurrence(name), cursor: "c2" }, "e1"),
    reopen: async () => { await registry.close(); registry = await EventsRegistry.open(join(root, "registry"), "session-one"); },
    async close() { await Promise.all(coordinators.map(c => c.close())); await registry.close(); owner.abort(); await manager.closeAll();
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

it("canonical list exposes validated webhook deliveryStatus without private extensions or driver state", async () => {
  const f = await fixture();
  try {
    f.reportDeliveryStatus(); const c = f.make(true);
    const sub = await c.subscribe({ server: "test", name: "webhook", delivery: "webhook" });
    expect(c.list().find(row => row.id === sub.id)).toMatchObject({ deliveryStatus: { active: false, lastError: "http_5xx", throttled: true, retryAfterMs: 60000 } });
    expect(JSON.stringify(c.list())).not.toMatch(/private-status-extension|whsec_|driverState|receiver.example/);
    expect(c.list().find(row => row.id === sub.id)?.deliveryStatus).toEqual({ active: false, lastError: "http_5xx", throttled: true, retryAfterMs: 60000 });
  } finally { await f.close(); }
});

it("negotiates configured webhook then push then poll; explicit selection never downgrades", async () => {
  const f = await fixture();
  try {
    const c = f.make(true);
    expect((await c.subscribe({ server: "test", name: "all" })).delivery).toBe("webhook");
    expect((await c.subscribe({ server: "test", name: "poll" })).delivery).toBe("poll");
    const push = await c.subscribe({ server: "test", name: "push" }); expect(push.delivery).toBe("push");
    await expect.poll(async () => (await c.pending(push.id)).length).toBe(1);
    await expect(c.subscribe({ server: "test", name: "poll", delivery: "push" })).rejects.toThrow();
    f.forbid();
    const count = f.log.filter(row => row.method === "events/poll" || row.method === "events/stream").length;
    await expect(c.subscribe({ server: "test", name: "webhook", delivery: "webhook" })).rejects.toThrow();
    expect(f.log.filter(row => row.method === "events/poll" || row.method === "events/stream")).toHaveLength(count);
    expect(JSON.stringify(c.list())).not.toContain("whsec_");
    expect(JSON.stringify(c.list())).not.toContain("receiver.example");
    const withoutWebhook = f.make();
    expect((await withoutWebhook.subscribe({ server: "test", name: "all" })).delivery).toBe("push");
  } finally { await f.close(); }
});

it("restores stable intents/cursors in the same Pi session; accepted records await explicit post-turn acknowledgement", async () => {
  const f = await fixture();
  try {
    const c = f.make();
    const sub = await c.subscribe({ server: "test", name: "poll", cursor: "c1" });
    expect(f.registry().list()[0]?.cursor).toBe("c2");
    expect(await c.pending(sub.id)).toMatchObject([{ subscriptionId: sub.id, id: "e1" }]);
    await c.close(); await f.reopen();
    const restored = f.make(); await restored.restore();
    expect(restored.list()[0]?.id).toBe(sub.id);
    expect(await restored.pending(sub.id)).toHaveLength(1);
    await restored.acknowledge([{ subscriptionId: sub.id, id: "e1" }]);
    expect(await restored.pending(sub.id)).toEqual([]);
    expect(f.log.filter(row => row.method === "events/poll").at(-1)?.params.cursor).toBe("c2");
    expect(await readFile(join(f.root, "registry", "subscriptions.json"), "utf8")).toContain("serverBinding");
  } finally { await f.close(); }
});

it("automatically reconnects polling after a real HTTP outage with the accepted cursor and stable logical identity", async () => {
  const f = await fixture();
  try {
    f.recoverPoll(); const c = f.make();
    const sub = await c.subscribe({ server: "test", name: "poll", delivery: "poll" });
    await expect.poll(() => c.list()[0]?.cursor, { timeout: 5000 }).toBe("c2");
    expect(c.list()[0]).toMatchObject({ id: sub.id, status: "active" });
    const polls = f.log.filter(row => row.method === "events/poll");
    expect(polls.slice(0, 3).map(row => row.params.cursor)).toEqual([null, "c1", "c1"]);
    expect(await c.pending(sub.id)).toHaveLength(1);
  } finally { await f.close(); }
});

it.each([-32026, -32024])("push termination %s rediscovery distinguishes schema change from authorization revocation", async code => {
  const f = await fixture();
  try {
    f.terminatePush(code); const c = f.make();
    const sub = await c.subscribe({ server: "test", name: "push", delivery: "push" });
    if (code === -32026) {
      await expect.poll(() => f.log.filter(row => row.method === "events/stream").length, { timeout: 4000 }).toBe(2);
      await expect.poll(() => c.list()[0]?.status).toBe("active");
      expect(c.list()[0]?.id).toBe(sub.id);
      expect(f.log.filter(row => row.method === "events/stream")[1]?.params.cursor).toBe("c1");
      expect(f.log.filter(row => row.method === "events/list").length).toBeGreaterThanOrEqual(3);
    } else {
      await expect.poll(() => c.list()[0]?.status).toBe("failed");
      expect(f.log.filter(row => row.method === "events/stream")).toHaveLength(1);
    }
  } finally { await f.close(); }
});

it.each(["http", "socket"] as const)("canonical webhook renewal recovers a real %s failure without changing identity", async kind => {
  const f = await fixture();
  try {
    f.recoverWebhook(kind); const c = f.make(true);
    const sub = await c.subscribe({ server: "test", name: "webhook" });
    await expect.poll(() => f.log.filter(row => row.method === "events/subscribe").length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(() => c.list()[0]?.status).toBe("active");
    if (kind === "socket") expect(f.connects()).toBeGreaterThan(1);
    expect(c.list()[0]?.id).toBe(sub.id);
  } finally { await f.close(); }
}, 10000);

it("exposes generated webhook rotation through the canonical coordinator without changing the subscription tuple", async () => {
  const f = await fixture();
  try {
    const c = f.make(true);
    const sub = await c.subscribe({ server: "test", name: "webhook" });
    const original = structuredClone(f.log.filter(row => row.method === "events/subscribe").at(-1)!.params);
    const rotated = await c.rotateSecret(sub.id);
    const latest = f.log.filter(row => row.method === "events/subscribe").at(-1)!.params;
    expect(latest.delivery.secret).not.toBe(original.delivery.secret);
    expect(latest.delivery.url).toBe(original.delivery.url);
    expect(latest.name).toBe(original.name); expect(latest.arguments).toEqual(original.arguments);
    expect(rotated).toMatchObject({ id: sub.id, delivery: "webhook", status: "active" });
    expect(JSON.stringify(rotated)).not.toContain("whsec_");
    expect((await f.emit("webhook")).status).toBe(202);
  } finally { await f.close(); }
});

it.each(["push", "webhook"] as const)("restores %s driver identity and pending records without exposing private state", async mode => {
  const f = await fixture();
  try {
    const c = f.make(true);
    const sub = await c.subscribe({ server: "test", name: mode });
    if (mode === "webhook") expect((await f.emit(mode)).status).toBe(202);
    await expect.poll(async () => (await c.pending(sub.id)).length).toBe(1);
    await c.close(); await f.reopen();
    const restored = f.make(true); await restored.restore();
    expect(restored.list()).toMatchObject([{ id: sub.id, delivery: mode }]);
    expect(await restored.pending(sub.id)).toHaveLength(1);
    expect(JSON.stringify(restored.list())).not.toContain("whsec_");
    await restored.acknowledge([{ subscriptionId: sub.id, id: "e1" }]);
    expect(await restored.pending(sub.id)).toEqual([]);
  } finally { await f.close(); }
});

it("awaits inbox acceptance before advancing a push recovery cursor or notifying Pi", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accepting = new Promise<void>(resolve => { entered = resolve; });
  const original = f.inbox.accept.bind(f.inbox);
  vi.spyOn(f.inbox, "accept").mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
  try {
    const c = f.make();
    const sub = await c.subscribe({ server: "test", name: "push" });
    await accepting;
    expect(f.registry().list()[0]?.cursor).toBe("c1");
    expect(f.notices).toEqual([]);
    release();
    await expect.poll(() => f.registry().list()[0]?.cursor).toBe("c2");
    expect(await c.pending(sub.id)).toHaveLength(1);
  } finally { release(); await f.close(); }
});

it("retries persisted webhook cleanup after failed registration rather than resuming delivery", async () => {
  const f = await fixture();
  try {
    const c = f.make(true); f.forbid();
    await expect(c.subscribe({ server: "test", name: "webhook" })).rejects.toThrow();
    const id = f.registry().list()[0]!.id;
    await c.close(); await f.reopen();
    const restored = f.make(true); await restored.restore();
    expect(f.log.some(row => row.method === "events/unsubscribe")).toBe(true);
    expect(restored.list()).toMatchObject([{ id, status: "stopped" }]);
    expect(f.registry().list()[0]?.driverState?.webhook).toMatchObject({ cleanupPending: false });
  } finally { await f.close(); }
});

it("durably marks webhook cleanup intent before a stop can be interrupted", async () => {
  const f = await fixture();
  try {
    const c = f.make(true); const sub = await c.subscribe({ server: "test", name: "webhook" });
    const registry = f.registry(), original = registry.save.bind(registry);
    let interrupted = false;
    vi.spyOn(registry, "save").mockImplementation(async entry => {
      await original(entry);
      if (!interrupted && entry.status === "stopped") { interrupted = true; throw new Error("simulated stop interruption"); }
    });
    await expect(c.unsubscribe(sub.id)).rejects.toThrow();
    await c.close(); await f.reopen();
    const restored = f.make(true); await restored.restore();
    expect(f.log.some(row => row.method === "events/unsubscribe")).toBe(true);
    expect(f.registry().list()[0]?.driverState?.webhook).toMatchObject({ status: "stopped", cleanupPending: false });
  } finally { await f.close(); }
});

it("keeps repeated webhook unsubscribe idempotent after remote cleanup completes", async () => {
  const f = await fixture();
  try {
    const c = f.make(true); const sub = await c.subscribe({ server: "test", name: "webhook" });
    await c.unsubscribe(sub.id); await c.unsubscribe(sub.id);
    expect(f.log.filter(row => row.method === "events/unsubscribe")).toHaveLength(1);
    expect(f.registry().list()[0]?.driverState?.webhook).toMatchObject({ cleanupPending: false });
  } finally { await f.close(); }
});

it("can eagerly unsubscribe a failed webhook intent whose local driver has been suspended", async () => {
  const f = await fixture();
  try {
    const c = f.make(true); f.forbid();
    await expect(c.subscribe({ server: "test", name: "webhook" })).rejects.toThrow();
    const id = f.registry().list()[0]!.id;
    await c.unsubscribe(id);
    expect(f.log.filter(row => row.method === "events/unsubscribe")).toHaveLength(1);
    expect(f.registry().list()[0]?.driverState?.webhook).toMatchObject({ cleanupPending: false });
  } finally { await f.close(); }
});

it("restores notification of accepted records for stopped subscriptions without restarting their workers", async () => {
  const f = await fixture();
  try {
    const c = f.make(); const sub = await c.subscribe({ server: "test", name: "poll", cursor: "c1" });
    await c.unsubscribe(sub.id); await c.close(); await f.reopen(); f.notices.length = 0;
    const before = f.log.filter(row => row.method === "events/poll").length;
    const restored = f.make(); await restored.restore();
    expect(f.notices).toEqual([sub.id]);
    expect(f.log.filter(row => row.method === "events/poll")).toHaveLength(before);
    expect(await restored.pending(sub.id)).toHaveLength(1);
    expect(restored.list()[0]?.status).toBe("stopped");
  } finally { await f.close(); }
});

it.each(["secret", "pendingSecret"])("validates private webhook restoration %s before starting any drivers", async field => {
  const f = await fixture();
  try {
    const c = f.make(true);
    await c.subscribe({ server: "test", name: "poll" });
    const hook = await c.subscribe({ server: "test", name: "webhook" });
    await c.close();
    const entry = f.registry().list().find(row => row.id === hook.id)!;
    await f.registry().save({ ...entry, driverState: { ...entry.driverState, webhook: { ...(entry.driverState?.webhook as object), [field]: "invalid" } } });
    const before = f.log.filter(row => ["events/poll", "events/subscribe", "events/stream"].includes(row.method)).length;
    await expect(f.make(true).restore()).rejects.toThrow();
    expect(f.log.filter(row => ["events/poll", "events/subscribe", "events/stream"].includes(row.method))).toHaveLength(before);
  } finally { await f.close(); }
});

it("rejects changed/missing restoration binding before starting drivers, and rejects a different Pi session", async () => {
  const f = await fixture();
  try {
    const c = f.make(); await c.subscribe({ server: "test", name: "poll" }); await c.close();
    const before = f.log.filter(row => row.method === "events/poll").length;
    const changed = f.make(false, async server => ({ ...await f.connect(server), serverBinding: "changed" }));
    await expect(changed.restore()).rejects.toThrow("binding");
    const missing = f.make(false, async server => {
      const { serverBinding: _binding, ...session } = await f.connect(server); return session;
    });
    await expect(missing.restore()).rejects.toThrow("binding");
    expect(f.log.filter(row => row.method === "events/poll")).toHaveLength(before);
    expect(() => new EventsCoordinator({ sessionId: "another-session", registry: f.registry(), inbox: f.inbox, connect: f.connect })).toThrow("session");
  } finally { await f.close(); }
});

it("validates push payloads, persists webhook driverState, and does not wake Pi for empty poll checkpoints", async () => {
  const f = await fixture();
  try {
    const c = f.make(true);
    await c.subscribe({ server: "test", name: "poll" }); expect(f.notices).toEqual([]);
    const hook = await c.subscribe({ server: "test", name: "webhook" });
    expect((await f.emit("webhook")).status).toBe(202);
    expect(await c.pending(hook.id)).toHaveLength(1);
    expect(f.registry().list().find(row => row.id === hook.id)?.driverState).toHaveProperty("webhook.secret");
    f.invalid();
    const push = await c.subscribe({ server: "test", name: "push" });
    await expect.poll(() => c.list().find(row => row.id === push.id)?.status).toBe("failed");
    expect(await c.pending(push.id)).toEqual([]);
  } finally { await f.close(); }
});
