import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { CoreClient, CORE_PROTOCOL } from "../mcp-core.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { McpServerManager } from "../server-manager.ts";

// The same wire peer runs over HTTP and a real Node stdio child.
function dispatch(m: any, send: (frame: any) => void) {
  const result = (result: any) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "server/discover") return result({ supportedVersions: ["2026-07-28"], capabilities: { resources: {}, extensions: { "io.modelcontextprotocol/tasks": {} } } });
  if (m.method === "initialize") return result({ protocolVersion: "2025-11-25", serverInfo: { name: "tasks", version: "1" }, capabilities: { tasks: { requests: { tools: { call: {} } } } } });
  if (m.method === "resources/list") return result({ resultType: "complete", resources: [], ttlMs: 0, cacheScope: "private" });
  if (m.method === "resources/templates/list") return result({ resultType: "complete", resourceTemplates: [], ttlMs: 0, cacheScope: "private" });
  if (m.method === "subscriptions/listen") {
    const ids = m.params.notifications.taskIds ?? [];
    const meta = { "io.modelcontextprotocol/subscriptionId": m.id };
    send({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: meta,
      notifications: { ...m.params.notifications, taskIds: ids[0] === "bad-ack" ? ["unsolicited"] : ids.slice(0, 1) }, request: m.params } });
    send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { _meta: meta, uri: "fixture://a" } });
    send({ jsonrpc: "2.0", method: "notifications/tasks", params: { _meta: meta, taskId: ids[0] === "bad-id" ? "unsolicited" : ids[0] === "bad-subset" ? ids[1] : ids[0], status: ids[0] === "bad-status" ? "completed" : ids[0] === "bad-enum" ? "bogus" : "working", createdAt: "now", lastUpdatedAt: "now", ttlMs: null } });
    return;
  }
  if (m.method === "ping") {
    result({});
    send({ jsonrpc: "2.0", method: "notifications/tasks/status", params: { taskId: "legacy", status: "working", createdAt: "now", lastUpdatedAt: "now", ttl: null } });
    send({ jsonrpc: "2.0", method: "notifications/tasks/status", params: { taskId: "legacy", status: "bogus" } });
  }
}

async function fixture(mode: "http" | "stdio") {
  const headers: any[] = [];
  if (mode === "stdio") return { definition: { command: process.execPath, args: ["--input-type=module", "-e",
    `import readline from 'node:readline'; const dispatch=${dispatch.toString()}; readline.createInterface({input:process.stdin}).on('line',line=>dispatch(JSON.parse(line),frame=>process.stdout.write(JSON.stringify(frame)+'\\n')));`] }, headers, close: async () => {} };
  const server = createServer(async (req, res) => {
    headers.push(req.headers);
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const m = JSON.parse(body);
    if (!("id" in m)) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    dispatch(m, frame => res.write(`data: ${JSON.stringify(frame)}\n\n`));
    if (m.method !== "subscriptions/listen") res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { definition: { url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, auth: false as const, headers: { "X-Task-Test": "configured" } }, headers,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const mode of ["http", "stdio"] as const) {
  it.each(["bad-ack", "bad-id", "bad-status", "bad-subset", "bad-enum"])(`${mode}: rejects %s without delivering invalid task data`, async taskId => {
    const f = await fixture(mode), manager = new McpServerManager();
    let core: CoreClient | undefined;
    try {
      const conn = await manager.connect("task-invalid", { ...f.definition, protocolVersion: "2026-07-28" });
      core = new CoreClient(createProtocolSession(conn, new AbortController().signal, CORE_PROTOCOL));
      try { await core.watch({ notifications: { taskIds: [taskId, "not-accepted"] } }); } catch (error) {
        expect(String(error)).toMatch(/task|result|invalid/i);
      }
      await expect.poll(() => core!.status().watches.length === 0 || core!.status().watches[0]?.state !== "active").toBe(true);
      expect(core.records.filter(r => r.method === "notifications/tasks")).toEqual([]);
      if (taskId === "bad-ack") expect(core.records).toEqual([]);
      expect(conn.activeProtocolOperations).toBe(0);
    } finally { core?.close(); await manager.closeAll(); await f.close(); }
  });
  it(`${mode}: observes validated legacy status notifications without a subscription stream`, async () => {
    const f = await fixture(mode), manager = new McpServerManager();
    let core: CoreClient | undefined;
    try {
      const conn = await manager.connect("task-legacy", { ...f.definition, protocolVersion: "legacy" });
      core = new CoreClient(createProtocolSession(conn, new AbortController().signal, CORE_PROTOCOL));
      await core.watch({ notifications: { taskIds: ["legacy"] } });
      await core.execute("ping");
      await expect.poll(() => core!.records.length).toBe(1);
      expect(core.records[0]).toMatchObject({ method: "notifications/tasks/status", params: { taskId: "legacy", status: "working" } });
    } finally { core?.close(); await manager.closeAll(); await f.close(); }
  });
  it(`${mode}: task filters coexist with resources, honor subsets and carry host metadata`, async () => {
    const f = await fixture(mode), manager = new McpServerManager();
    let core: CoreClient | undefined;
    try {
      const conn = await manager.connect("task-notifications", { ...f.definition, protocolVersion: "2026-07-28" });
      core = new CoreClient(createProtocolSession(conn, new AbortController().signal, CORE_PROTOCOL));
      const watched = await core.watch({ notifications: { taskIds: ["one", "two", "one"], resourceSubscriptions: ["fixture://a"] } });
      expect(watched.notifications).toEqual({ taskIds: ["one"], resourceSubscriptions: ["fixture://a"] });
      await expect.poll(() => core!.records.some(r => r.method === "notifications/tasks")).toBe(true);
      expect(core.records.some(r => r.method === "notifications/resources/updated")).toBe(true);
      const request = core.records[0]!.params.request as any;
      expect(request.notifications.taskIds).toEqual(["one", "two"]);
      expect(request._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]).toEqual({});
      expect(request._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      expect(request._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/skills"]).toEqual({});
      expect(request._meta["io.modelcontextprotocol/clientInfo"].name).toBeTruthy();
      if (mode === "http") expect(f.headers.every(h => h["x-task-test"] === "configured")).toBe(true);
    } finally { core?.close(); await manager.closeAll(); await f.close(); }
  });
}
