import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { WebhookReceiver } from "../mcp-events-webhook.ts";

it("webhook HTTP boundary verifies a signed challenge before activating event delivery", async () => {
  const accepted: unknown[] = [];
  const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
  const receiver = new WebhookReceiver();
  const route = receiver.register({ path: "/hooks/proof", secret, name: "tick",
    payloadSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] },
    accept: async delivery => { accepted.push(delivery); },
  });
  const post = (body: object, id: string, valid = true) => {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.alloc(32, 7)).update(`${id}.${timestamp}.${raw}`).digest("base64");
    return receiver.handle(new Request("https://receiver.example/hooks/proof", { method: "POST", body: raw,
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${valid ? signature : "invalid"}`, "X-MCP-Subscription-Id": "server-sub" },
    }));
  };
  expect((await post({ type: "verification", challenge: "single-use-challenge" }, "msg_verification_1", false)).status).toBe(401);
  const challenge = await post({ type: "verification", challenge: "single-use-challenge" }, "msg_verification_1");
  expect(challenge.status).toBe(200);
  expect(await challenge.json()).toEqual({ challenge: "single-use-challenge" });
  const event = { eventId: "e1", name: "tick", timestamp: new Date().toISOString(), data: { value: 42 }, cursor: "c1" };
  expect((await post(event, "e1")).status).toBe(425);
  route.activate("server-sub");
  expect((await post({ ...event, data: { value: "bad" } }, "e1")).status).toBe(400);
  expect((await post(event, "e1")).status).toBe(202);
  expect(accepted).toEqual([event]);
  route.updatePayloadSchema({ type: "object", required: ["value"], properties: { value: { type: "string" } } });
  expect((await post(event, "e1")).status).toBe(400);
  expect((await post({ ...event, data: { value: "new schema" } }, "e1")).status).toBe(202);
  route.close();
  expect((await post(event, "e1")).status).toBe(404);
});

it("webhook HTTP boundary does not acknowledge a delivery until the application accepts it", async () => {
  const receiver = new WebhookReceiver();
  const key = Buffer.alloc(32, 9);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const accepting = new Promise<void>(resolve => { entered = resolve; });
  const route = receiver.register({ path: "/slow", secret: "whsec_" + key.toString("base64"), name: "tick",
    payloadSchema: { type: "object" }, accept: async () => { entered(); await gate; },
  });
  route.activate("sub");
  const body = JSON.stringify({ eventId: "e1", name: "tick", timestamp: new Date().toISOString(), data: {} });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(`e1.${ts}.${body}`).digest("base64");
  let acknowledged = false;
  const response = receiver.handle(new Request("https://receiver.example/slow", { method: "POST", body,
    headers: { "content-type": "application/json", "webhook-id": "e1", "webhook-timestamp": ts,
      "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": "sub" },
  })).then(result => { acknowledged = true; return result; });
  await accepting;
  expect(acknowledged).toBe(false);
  release();
  expect((await response).status).toBe(202);
});

it("webhook receiver rejects a noncanonical timestamp header even with an otherwise matching signature", async () => {
  const receiver = new WebhookReceiver();
  const key = Buffer.alloc(32, 11);
  const route = receiver.register({ path: "/timestamp", secret: "whsec_" + key.toString("base64"), name: "tick",
    payloadSchema: { type: "object" }, accept: async () => { throw new Error("Must not reach application"); },
  });
  route.activate("sub");
  const body = JSON.stringify({ type: "verification", challenge: "nonce" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(`msg_verification_1.${timestamp}.${body}`).digest("base64");
  const result = await receiver.handle(new Request("https://receiver.example/timestamp", { method: "POST", body,
    headers: { "content-type": "application/json", "webhook-id": "msg_verification_1", "webhook-timestamp": timestamp + "junk",
      "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": "sub" },
  }));
  expect(result.status).toBe(401);
});

it("closing a webhook route revokes a delivery still reading its request body", async () => {
  const receiver = new WebhookReceiver();
  const accepted: unknown[] = [];
  const key = Buffer.alloc(32, 13);
  const route = receiver.register({ path: "/closing", secret: "whsec_" + key.toString("base64"), name: "tick",
    payloadSchema: { type: "object" }, accept: async value => { accepted.push(value); },
  });
  route.activate("sub");
  const body = JSON.stringify({ eventId: "e1", name: "tick", timestamp: new Date().toISOString(), data: {} });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(`e1.${timestamp}.${body}`).digest("base64");
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const request = new Request("https://receiver.example/closing", { method: "POST",
    body: new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
    duplex: "half", headers: { "content-type": "application/json", "webhook-id": "e1", "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": "sub" },
  } as RequestInit);
  const response = receiver.handle(request);
  route.close();
  stream.enqueue(new TextEncoder().encode(body)); stream.close();
  expect((await response).status).toBe(404);
  expect(accepted).toEqual([]);
});

it("webhook signatures cannot authenticate malformed UTF-8 by replacement-character normalization", async () => {
  const receiver = new WebhookReceiver();
  const accepted: unknown[] = [];
  const key = Buffer.alloc(32, 15);
  const route = receiver.register({ path: "/bytes", secret: "whsec_" + key.toString("base64"), name: "tick",
    payloadSchema: { type: "object" }, accept: async value => { accepted.push(value); },
  });
  route.activate("sub");
  const body = JSON.stringify({ eventId: "e1", name: "tick", timestamp: new Date().toISOString(), data: { text: "�" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(`e1.${timestamp}.${body}`).digest("base64");
  const bytes = Buffer.from(body);
  const index = bytes.indexOf(Buffer.from("�"));
  const malformed = Buffer.concat([bytes.subarray(0, index), Buffer.from([255]), bytes.subarray(index + 3)]);
  const response = await receiver.handle(new Request("https://receiver.example/bytes", { method: "POST",
    body: new Uint8Array(malformed).buffer,
    headers: { "content-type": "application/json", "webhook-id": "e1", "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": "sub" },
  }));
  expect(response.status).toBe(400);
  expect(accepted).toEqual([]);
});
