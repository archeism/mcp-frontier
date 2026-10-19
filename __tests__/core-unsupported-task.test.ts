import { createServer } from "node:http";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { CoreClient, CORE_PROTOCOL } from "../mcp-core.ts";
import { createProtocolSession } from "../runtime-protocol.ts";

it("rejects a valid task-creation discriminator on a core method which cannot be augmented", async () => {
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const q = JSON.parse(body);
    const complete = (value: object) => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...value });
    const result = q.method === "server/discover" ? complete({ supportedVersions: ["2026-07-28"], capabilities: {
      tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/tasks": {} } } }) :
      q.method === "tools/list" ? complete({ tools: [] }) : q.method === "resources/list" ? complete({ resources: [] }) :
      q.method === "resources/templates/list" ? complete({ resourceTemplates: [] }) : {
        resultType: "task", taskId: "unpermitted-task", status: "working", createdAt: "2026-10-17T00:00:00Z",
        lastUpdatedAt: "2026-10-17T00:00:00Z", ttlMs: 1000, pollIntervalMs: 10,
      };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
  const manager = new McpServerManager(process.cwd());
  try {
    const connection = await manager.connect("fixture", { url: `http://127.0.0.1:${address.port}/mcp`, auth: false, protocolVersion: "2026-07-28", tasks: true });
    const client = new CoreClient(createProtocolSession(connection, new AbortController().signal, CORE_PROTOCOL));
    await expect(client.execute("resources/read", { uri: "fixture://readme" })).rejects.toThrow(/task|augment|complete/i);
    await client.close();
  } finally {
    await manager.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
