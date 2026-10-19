import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { WebhookReceiver } from "../mcp-events-webhook.ts";

afterEach(() => vi.useRealTimers());
function fixture() {
  const receiver = new WebhookReceiver(), accepted: unknown[] = [];
  const key = Buffer.alloc(32, 19), other = Buffer.alloc(32, 21);
  const route = receiver.register({ path: "/hooks/security", secret: "whsec_" + key.toString("base64"), name: "tick",
    payloadSchema: { type: "object" }, accept: async value => { accepted.push(value); } });
  route.activate("sub");
  const body = JSON.stringify({ eventId: "e1", name: "tick", timestamp: "2026-10-17T00:00:00Z", data: { value: "original" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = (raw = body, ts = timestamp, signingKey = key) => "v1," + createHmac("sha256", signingKey).update(`e1.${ts}.${raw}`).digest("base64");
  const headers = { "content-type": "application/json", "webhook-id": "e1", "webhook-timestamp": timestamp,
    "webhook-signature": sign(), "x-mcp-subscription-id": "sub" };
  const post = (override: Record<string, string> = {}, raw = body, path = "/hooks/security") => receiver.handle(new Request("https://receiver.example" + path,
    { method: "POST", body: raw, headers: { ...headers, ...override } }));
  return { receiver, accepted, route, body, timestamp, sign, headers, post, other };
}

it.each([-301, 301])("rejects a correctly signed timestamp %s seconds away without application delivery", async offset => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  const f = fixture(), timestamp = String(Number(f.timestamp) + offset);
  expect((await f.post({ "webhook-timestamp": timestamp, "webhook-signature": f.sign(f.body, timestamp) })).status).toBe(401);
  expect(f.accepted).toEqual([]);
});

it.each(["valid-first", "valid-last", "old-first", "new-first"])("accepts any valid v1 signature independent of ordering: %s", async ordering => {
  const f = fixture(), old = f.sign(), newer = f.sign(f.body, f.timestamp, f.other), invalid = "v1," + Buffer.alloc(32).toString("base64");
  if (ordering.startsWith("old") || ordering.startsWith("new")) f.route.updateSecrets(["whsec_" + f.other.toString("base64")]);
  const signature = ordering === "valid-first" ? `${old} ${invalid}` : ordering === "valid-last" ? `${invalid} ${old}` :
    ordering === "old-first" ? `${old} ${newer}` : `${newer} ${old}`;
  expect((await f.post({ "webhook-signature": signature })).status).toBe(202);
  expect(f.accepted).toHaveLength(1);
});

it.each(["webhook-id", "webhook-timestamp", "webhook-signature", "x-mcp-subscription-id"])("rejects missing required header %s before acceptance", async omitted => {
  const f = fixture(), headers = new Headers(f.headers); headers.delete(omitted);
  const response = await f.receiver.handle(new Request("https://receiver.example/hooks/security", { method: "POST", body: f.body, headers }));
  expect(response.status).toBeGreaterThanOrEqual(400); expect(f.accepted).toEqual([]);
});

it.each(["path", "subscription", "content-type", "method"])("rejects wrong receiver boundary %s", async kind => {
  const f = fixture();
  const response = kind === "path" ? await f.post({}, f.body, "/hooks/unknown") : kind === "subscription" ? await f.post({ "x-mcp-subscription-id": "other" }) :
    kind === "content-type" ? await f.post({ "content-type": "text/plain" }) : await f.receiver.handle(new Request("https://receiver.example/hooks/security", { headers: f.headers }));
  expect(response.status).toBeGreaterThanOrEqual(400); expect(f.accepted).toEqual([]);
});

it("authenticates raw body bytes rather than accepting a modified signed JSON payload", async () => {
  const f = fixture();
  expect((await f.post({}, f.body.replace("original", "modified"))).status).toBe(401);
  expect(f.accepted).toEqual([]);
});

it("admits the 256 KiB boundary and rejects streamed bytes above it despite a forged Content-Length", async () => {
  const f = fixture(), empty = JSON.stringify({ eventId: "e1", name: "tick", timestamp: "2026-10-17T00:00:00Z", data: { padding: "" } });
  const body = empty.replace('"padding":""', '"padding":"' + "x".repeat(256 * 1024 - Buffer.byteLength(empty)) + '"');
  expect(Buffer.byteLength(body)).toBe(256 * 1024);
  expect((await f.post({ "webhook-signature": f.sign(body) }, body)).status).toBe(202);
  f.accepted.length = 0;
  let cancelled = false;
  const response = await f.receiver.handle(new Request("https://receiver.example/hooks/security", { method: "POST",
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { cancelled = true; } }),
    duplex: "half", headers: { ...f.headers, "content-length": "1" },
  } as RequestInit));
  expect(response.status).toBe(413); expect(cancelled).toBe(true); expect(f.accepted).toEqual([]);
});
