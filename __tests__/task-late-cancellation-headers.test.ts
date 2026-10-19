import { createServer } from "node:http";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { callToolViaTaskSession } from "../mcp-tasks.ts";

it.each(["abort", "timeout"] as const)("retains per-call authentication headers on real HTTP late cancellation after %s", async termination => {
  let entered!: () => void, release!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const cancellations: Array<{ authenticated: boolean; routed: boolean; framed: boolean }> = [];
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(200).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const frame = JSON.parse(body);
    const reply = (result: object) => res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    if (frame.method === "server/discover") { reply({ resultType: "complete", supportedVersions: ["2026-07-28"],
      capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } } }); return; }
    if (frame.method === "tools/list") { reply({ resultType: "complete", ttlMs: 0, cacheScope: "private",
      tools: [{ name: "work", inputSchema: { type: "object" } }] }); return; }
    if (frame.method === "tools/call") {
      expect(req.headers["x-request-auth"]).toBe("fake-per-call-credential");
      release = () => reply({ resultType: "task", taskId: "late-http-task", status: "working",
        createdAt: "2026-10-17T00:00:00Z", lastUpdatedAt: "2026-10-17T00:00:00Z", ttlMs: 60000 });
      entered(); return;
    }
    if (frame.method === "tasks/cancel") {
      const meta = frame.params._meta;
      const evidence = { authenticated: req.headers["x-request-auth"] === "fake-per-call-credential",
        routed: req.headers["mcp-name"] === "late-http-task" && req.headers["mcp-method"] === "tasks/cancel",
        framed: meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28" &&
          meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.["io.modelcontextprotocol/tasks"] !== undefined };
      cancellations.push(evidence);
      if (!evidence.authenticated) { res.writeHead(403).end("Missing per-call authorization"); return; }
      reply({ resultType: "complete" }); return;
    }
    res.writeHead(500).end(`Unexpected ${frame.method}`);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
  const manager = new McpServerManager(process.cwd());
  try {
    const connection = await manager.connect("late", { url: `http://127.0.0.1:${address.port}/mcp`,
      auth: false, protocolVersion: "2026-07-28", tasks: true });
    const controller = new AbortController();
    const pending = callToolViaTaskSession(connection.taskSession!, { name: "work", args: {}, signal: controller.signal,
      requestTimeoutMs: termination === "timeout" ? 100 : 2000,
      requestOptions: { headers: { "X-Request-Auth": "fake-per-call-credential", "mcp-name": "incorrect-original-route" } } });
    const rejected = expect(pending).rejects.toThrow();
    await called;
    if (termination === "abort") controller.abort();
    await rejected;
    release();
    await expect.poll(() => cancellations.length).toBe(1);
    expect(cancellations).toEqual([{ authenticated: true, routed: true, framed: true }]);
  } finally {
    await manager.closeAll(); http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
}, 10000);
