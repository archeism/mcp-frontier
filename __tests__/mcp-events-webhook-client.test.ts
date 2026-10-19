import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";
import { WebhookReceiver } from "../mcp-events-webhook.ts";
import { WebhookEventsClient, WEBHOOK_EVENTS_PROTOCOL, type WebhookSubscriptionState, type WebhookEventsOptions } from "../mcp-events-webhook-client.ts";

it("authenticated SDK webhook subscription verifies callback, accepts events, renews TTL, restores and eagerly unsubscribes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-webhook-client-"));
  const receiver = new WebhookReceiver();
  const inbox = new DurableWebhookInbox(join(root, "inbox"));
  const requests: Array<{ method: string; params: any }> = [];
  let registration: any;
  let notified = 0;
  let removed = false;
  let stringPayload = false;
  let catalogChanged!: () => void;
  const send = async (body: object, id: string) => {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = Buffer.from(registration.delivery.secret.slice(6), "base64");
    const signature = createHmac("sha256", secret).update(`${id}.${timestamp}.${raw}`).digest("base64");
    return receiver.handle(new Request(registration.delivery.url, { method: "POST", body: raw,
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": "remote-sub" },
    }));
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-auth") { res.writeHead(401).end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    const complete = (result: object) => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...result });
    let result: object = {};
    if (request.method === "server/discover") result = complete({ supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} } });
    else if (request.method === "tools/list") result = complete({ tools: [] });
    else if (request.method === "events/list") result = complete({ events: removed ? [] : [{ name: "tick", delivery: ["webhook"], inputSchema: { type: "object" }, payloadSchema: { type: "object", required: ["value"], properties: { value: { type: stringPayload ? "string" : "number" } } } }] });
    else if (request.method === "events/subscribe") {
      registration = request.params;
      const response = await send({ type: "verification", challenge: "fixture-nonce" }, "msg_verification_1");
      if (response.status !== 200 || (await response.json()).challenge !== "fixture-nonce") throw new Error("Callback verification failed");
      result = complete({ id: "remote-sub", refreshBefore: new Date(Date.now() + 300).toISOString(), cursor: "quiet", truncated: false });
    } else if (request.method === "events/unsubscribe") result = complete({});
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const manager = new McpServerManager(process.cwd());
  let client: WebhookEventsClient | undefined;
  try {
    const connection = await manager.connect("webhook", { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "Bearer fixture-auth" }, auth: false, protocolVersion: "2026-07-28", tasks: false });
    const session = createProtocolSession(connection, new AbortController().signal, WEBHOOK_EVENTS_PROTOCOL);
    const watch = session.watchNotifications.bind(session);
    session.watchNotifications = (methods, notify) => {
      catalogChanged = () => notify("notifications/events/list_changed", {});
      return watch(methods, notify);
    };
    const saved: WebhookSubscriptionState[] = [];
    const options: WebhookEventsOptions = { receiver, inbox, callbackBaseUrl: "https://receiver.example/hooks", scope: "pi-session",
      save: async state => { saved.push(structuredClone(state)); }, onPending: () => { notified++; },
    };
    client = new WebhookEventsClient("webhook", session, options);
    const sub = await client.subscribe("tick", {}, { ttlMs: 1000 });
    expect(sub).toMatchObject({ status: "active", delivery: "webhook", cursor: "quiet" });
    expect(JSON.stringify(sub)).not.toContain("whsec_");
    const event = { eventId: "e1", name: "tick", timestamp: new Date().toISOString(), data: { value: 42 }, cursor: "c1" };
    expect((await send(event, "e1")).status).toBe(202);
    expect((await send(event, "e1")).status).toBe(202);
    expect((await inbox.pending(`pi-session/${sub.id}`))).toEqual([{ id: "e1", delivery: event }]);
    expect(notified).toBe(1);
    await expect.poll(() => requests.filter(row => row.method === "events/subscribe").length).toBeGreaterThanOrEqual(2);
    expect(requests.filter(row => row.method === "events/subscribe").at(-1)!.params.cursor).toBe("c1");
    stringPayload = true;
    catalogChanged();
    // A previously valid signed payload cannot cross a descriptor revocation.
    const obsolete = { ...event, eventId: "obsolete" };
    expect((await send(obsolete, "obsolete")).status).not.toBe(202);
    expect((await inbox.pending(`pi-session/${sub.id}`)).map(row => row.id)).not.toContain("obsolete");
    expect((await send({ ...event, eventId: "new-schema", data: { value: "accepted" } }, "new-schema")).status).toBe(202);
    await inbox.acknowledge(`pi-session/${sub.id}`, "new-schema");
    stringPayload = false; catalogChanged();
    const checkpoint = saved.at(-1)!;
    await client.suspend();
    expect(requests.some(row => row.method === "events/unsubscribe")).toBe(false);
    client = new WebhookEventsClient("webhook", createProtocolSession(connection, new AbortController().signal, WEBHOOK_EVENTS_PROTOCOL), options);
    await expect(client.restore([checkpoint, { ...checkpoint, id: randomUUID(), server: "different-server" }])).rejects.toThrow("receiver/server");
    expect(client.status()).toEqual([]);
    expect((await send(event, "e1")).status).toBe(404);
    const restored = await client.restore([checkpoint]);
    expect(restored[0]).toMatchObject({ id: sub.id, status: "active" });
    expect(notified).toBe(3); // Only the unacknowledged delivery survives suspension.
    expect(registration.delivery.secret).toBe(checkpoint.secret);
    await client.unsubscribe(sub.id);
    const cleanup = requests.find(row => row.method === "events/unsubscribe")!;
    expect(cleanup.params).toMatchObject({ name: "tick", arguments: {}, delivery: { url: registration.delivery.url } });
    expect(cleanup.params).not.toHaveProperty("id");
    expect((await send(event, "e1")).status).toBe(404);
    expect(saved.length).toBeGreaterThan(1);
    await client.suspend();
    removed = true;
    client = new WebhookEventsClient("webhook", createProtocolSession(connection, new AbortController().signal, WEBHOOK_EVENTS_PROTOCOL), options);
    // Cleanup must remain possible after the provider removes the descriptor.
    const stopped = await client.restore([{ ...checkpoint, status: "stopped", cleanupPending: true }]);
    expect(stopped[0]).toMatchObject({ status: "stopped", cleanupPending: false });
  } finally {
    await client?.close(); await manager.closeAll();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
