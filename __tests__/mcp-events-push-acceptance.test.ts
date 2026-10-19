import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EventConnection } from "../event-companion/src/stream.ts";
import { EVENTS_PROTOCOL } from "../event-companion/src/protocol.ts";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";

function makeDispatch() {
  const streams = new Map<string, (value: unknown) => void>();
  return (request: any, send: (value: unknown) => void) => {
    const complete = (body: object) => send({ jsonrpc: "2.0", id: request.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", ...body } });
    const notify = (id: string, method: string, body: object) => streams.get(id)?.({ jsonrpc: "2.0", method: "notifications/events/" + method,
      params: { ...body, _meta: { "io.modelcontextprotocol/subscriptionId": id } } });
    if (request.method === "server/discover") return complete({ supportedVersions: ["2026-07-28"], capabilities: { events: {}, tools: {} } });
    if (request.method === "tools/list") return complete({ tools: [{ name: "emit", inputSchema: { type: "object" } }] });
    if (request.method === "events/list") return complete({ events: [{ name: "tick", delivery: ["push"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }] });
    if (request.method === "events/stream") { streams.set(request.id, send); notify(request.id, "active", { cursor: "0" }); return; }
    if (request.method === "tools/call") {
      const args = request.params.arguments;
      notify(args.subscriptionId, "event", { eventId: "e1", name: "tick", timestamp: "2026-10-16T14:00:00Z", data: { value: args.value }, cursor: args.cursor });
      return complete({ content: [{ type: "text", text: "emitted" }] });
    }
    if (request.method === "notifications/cancelled") { streams.delete(request.params.requestId); return; }
    if (request.id !== undefined) return complete({});
  };
}
const source = `import readline from 'node:readline';const dispatch=(${makeDispatch.toString()})();readline.createInterface({input:process.stdin}).on('line',line=>dispatch(JSON.parse(line),frame=>process.stdout.write(JSON.stringify(frame)+'\\n')));`;

async function fixture(mode: "stdio" | "http") {
  const dispatch = makeDispatch();
  const http = mode === "http" ? createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (request.id === undefined) { dispatch(request, () => {}); res.writeHead(202).end(); return; }
    if (request.method === "events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" }); dispatch(request, frame => res.write(`data: ${JSON.stringify(frame)}\n\n`));
    } else dispatch(request, frame => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(frame)));
  }) : undefined;
  if (http) await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http?.address();
  const server = address && typeof address !== "string" ? { url: `http://127.0.0.1:${address.port}/mcp`, auth: false as const }
    : { command: process.execPath, args: ["--input-type=module", "-e", source] };
  const manager = new McpServerManager(process.cwd()), owner = new AbortController();
  const connection = await manager.connect("push-proof", { ...server, protocolVersion: "2026-07-28", tasks: false });
  const session = createProtocolSession(connection, owner.signal, EVENTS_PROTOCOL);
  return { session, emit: (subscriptionId: string, value: number, cursor: string) => connection.client.callTool({ name: "emit", arguments: { subscriptionId, value, cursor } }),
    async close() { owner.abort(); await manager.closeAll();
      if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } } };
}

for (const mode of ["stdio", "http"] as const) {
  it(`${mode}: the inbox sees every push retry; conflicts fail without advancing cursor or duplicating model callbacks`, async () => {
    const root = await mkdtemp(join(tmpdir(), "push-conflict-"));
    const inbox = new DurableWebhookInbox(root), f = await fixture(mode);
    const attempted: number[] = [], received: unknown[] = [];
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acceptingRetry = new Promise<void>(resolve => { reached = resolve; });
    const driver = new EventConnection("push-proof", f.session, (_sub, event) => { received.push(event); }, undefined, undefined, 15000, {
      acceptEvent: async (_sub, event) => {
        attempted.push((event.data as { value: number }).value);
        if (attempted.length === 2) { reached(); await gate; }
        await inbox.accept("push-proof", event.eventId, event as any);
      },
    });
    try {
      const sub = await driver.subscribe("tick", {});
      await f.emit(sub.id, 1, "1");
      await expect.poll(() => received.length).toBe(1);
      await f.emit(sub.id, 1, "2");
      await expect.poll(() => attempted.length).toBe(2);
      await acceptingRetry;
      expect(sub.cursor).toBe("1");
      expect(received).toHaveLength(1);
      release();
      await expect.poll(() => sub.cursor).toBe("2");
      await f.emit(sub.id, 2, "3");
      await expect.poll(() => sub.status).toBe("failed");
      expect(sub.error).toContain("different payload");
      expect(sub.cursor).toBe("2");
      expect(attempted).toEqual([1, 1, 2]);
      expect(received).toHaveLength(1);
      expect(await inbox.pending("push-proof")).toMatchObject([{ id: "e1", delivery: { data: { value: 1 }, cursor: "1" } }]);
    } finally { release(); driver.close(); await f.close(); await rm(root, { recursive: true, force: true }); }
  });
}
