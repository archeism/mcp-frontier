import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { WebhookReceiver } from "./mcp-events-webhook.ts";

export interface WebhookListenerOptions {
  host?: string;
  port: number;
  /** Omit only when operator-controlled ingress terminates HTTPS upstream. */
  tls?: { certFile: string; keyFile: string };
}

/** Optional local ingress. Public callback URLs are separately required to use HTTPS. */
export async function startWebhookListener(receiver: WebhookReceiver, options: WebhookListenerOptions) {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid webhook receiver port");
  const handler = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      }
      const method = incoming.method ?? "GET";
      const init: RequestInit & { duplex: "half" } = { method, headers, duplex: "half" };
      if (method !== "GET" && method !== "HEAD") init.body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
      const request = new Request(new URL(incoming.url ?? "/", "http://callback.invalid"), init);
      const response = await receiver.handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  };
  const settings = { maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 10000, keepAliveTimeout: 1000 };
  const server = options.tls
    ? createHttpsServer({ ...settings, cert: await readFile(options.tls.certFile), key: await readFile(options.tls.keyFile) }, handler)
    : createHttpServer(settings, handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Webhook receiver did not bind TCP"); }
  return { port: address.port, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
