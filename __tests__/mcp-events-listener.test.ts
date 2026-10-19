import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebhookReceiver } from "../mcp-events-webhook.ts";
import { startWebhookListener } from "../mcp-events-listener.ts";

it("real HTTPS callback receiver validates TLS and Standard Webhooks without disabling certificate verification", async () => {
  const receiver = new WebhookReceiver();
  const key = Buffer.alloc(32, 21);
  receiver.register({ path: "/hooks/test", secret: "whsec_" + key.toString("base64"), name: "tick", payloadSchema: { type: "object" }, accept: async () => {} });
  const certFile = fileURLToPath(new URL("./fixtures/ca/server.pem", import.meta.url));
  const keyFile = fileURLToPath(new URL("./fixtures/ca/server-key.pem", import.meta.url));
  const listener = await startWebhookListener(receiver, { host: "127.0.0.1", port: 0, tls: { certFile, keyFile } });
  try {
    const body = JSON.stringify({ type: "verification", challenge: "real-https-challenge" });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", key).update(`msg_verification_1.${ts}.${body}`).digest("base64");
    const post = (ca?: Buffer) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: listener.port, path: "/hooks/test", method: "POST", ...(ca ? { ca } : {}),
        headers: { "content-type": "application/json", "webhook-id": "msg_verification_1", "webhook-timestamp": ts,
          "webhook-signature": `v1,${signature}`, "x-mcp-subscription-id": "sub" },
      }, res => { let received = ""; res.on("data", chunk => { received += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body: received })); });
      req.on("error", reject); req.end(body);
    });
    await expect(post()).rejects.toThrow(/certificate|self.signed/i);
    const response = await post(await readFile(certFile));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ challenge: "real-https-challenge" });
  } finally { await listener.close(); }
});
