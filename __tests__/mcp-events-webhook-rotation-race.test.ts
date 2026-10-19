import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { EventsCoordinator } from "../mcp-events-coordinator.ts";
import { EventsRegistry } from "../mcp-events-registry.ts";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";
import { WebhookReceiver } from "../mcp-events-webhook.ts";
import type { McpProtocolSession } from "../runtime-protocol.ts";

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "webhook-rotation-race-"));
  const registry = await EventsRegistry.open(join(root, "registry"), "A");
  const inbox = new DurableWebhookInbox(join(root, "inbox")), receiver = new WebhookReceiver();
  const saving = gate(), releaseSave = gate(), accepting = gate(), renewing = gate(), releaseRenewal = gate();
  const save = registry.save.bind(registry), accept = inbox.accept.bind(inbox);
  let blocked = false;
  vi.spyOn(registry, "save").mockImplementation(async entry => {
    if (entry.driverState?.webhook?.pendingSecret && !blocked) {
      blocked = true; saving.resolve(); await releaseSave.promise;
    }
    await save(entry);
  });
  vi.spyOn(inbox, "accept").mockImplementation(async (...args) => { const result = await accept(...args); accepting.resolve(); return result; });
  const keys: string[] = [];
  const session: McpProtocolSession = {
    signal: new AbortController().signal, serverBinding: "binding", protocolVersion: "2026-07-28", serverCapabilities: { events: {} },
    getEventsCapabilities: async () => ({}), close() {},
    watchNotifications: () => ({ close() {}, closed: new Promise(() => {}) }),
    openStream() { throw new Error("No downgrade"); },
    async request(method, params) {
      if (method === "events/list") return { events: [{ name: "tick", delivery: ["webhook"], inputSchema: {}, payloadSchema: {} }] };
      if (method === "events/subscribe") {
        keys.push((params as any).delivery.secret);
        if (keys.length > 1) { renewing.resolve(); await releaseRenewal.promise; }
        return { id: "remote", refreshBefore: new Date(Date.now() + 10000).toISOString(), cursor: "watermark" };
      }
      return {};
    },
  };
  const coordinator = new EventsCoordinator({ sessionId: "A", registry, inbox, connect: async () => session,
    webhook: { receiver, callbackBaseUrl: "https://receiver.example/hooks" } });
  const sub = await coordinator.subscribe({ server: "test", name: "tick", delivery: "webhook" });
  const state = () => registry.list()[0]!.driverState!.webhook as any;
  const original = state();
  async function post(body: object, key: string, id: string) {
    const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from(key.slice(6), "base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
    return receiver.handle(new Request(original.callbackUrl, { method: "POST", body: raw, headers: {
      "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": "remote",
    } }));
  }
  return { coordinator, sub, state, original, keys, saving, releaseSave, accepting, renewing, releaseRenewal, post,
    async close() { releaseSave.resolve(); releaseRenewal.resolve(); await coordinator.close(); await registry.close(); await rm(root, { recursive: true, force: true }); } };
}

it("coordinator callback persistence cannot overwrite durable pending rotation intent", async () => {
  const f = await fixture();
  const rotation = f.coordinator.rotateSecret(f.sub.id); void rotation.catch(() => {});
  try {
    await f.saving.promise;
    const delivery = f.post({ eventId: "e1", name: "tick", timestamp: "2026-10-17T00:00:00Z", data: {}, cursor: "delivery-cursor" }, f.original.secret, "e1");
    await f.accepting.promise;
    await new Promise(resolve => setImmediate(resolve));
    f.releaseSave.resolve(); await f.renewing.promise;
    expect((await delivery).status).toBe(202);
    expect(f.state().cursor).toBe("delivery-cursor");
    expect(f.state().secret).toBe(f.original.secret);
    expect(f.state().pendingSecret).toBe(f.keys[1]);
  } finally { f.releaseRenewal.resolve(); await rotation.catch(() => {}); await f.close(); }
});

it("timer refresh during pending-key persistence never promotes a key it did not send", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const rotation = f.coordinator.rotateSecret(f.sub.id); void rotation.catch(() => {});
  try {
    await f.saving.promise;
    await vi.advanceTimersByTimeAsync(8000);
    // The disk boundary is still held: no request may use uncommitted intent,
    // nor may rotation subsequently join an old-key timer request as success.
    expect(f.keys).toEqual([f.original.secret]);
    f.releaseSave.resolve(); await f.renewing.promise;
    f.releaseRenewal.resolve(); await rotation;
    expect(f.keys.at(-1)).toBe(f.state().secret);
    expect(f.state().secret).not.toBe(f.original.secret);
    expect((await f.post({ type: "verification", challenge: "nonce" }, f.keys.at(-1)!, "verification")).status).toBe(200);
  } finally { f.releaseSave.resolve(); f.releaseRenewal.resolve(); await rotation.catch(() => {}); await f.close(); vi.useRealTimers(); }
});
