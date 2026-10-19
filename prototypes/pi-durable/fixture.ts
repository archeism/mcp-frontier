import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { ServerDefinition } from "../../types.ts";

/** Controlled modern wire fixture, following native-codemode-events-skills.
 * No Pi host or credentials. Repeated poll deliveries deliberately test dedup.
 * Count tasks/get in wire (also reported in its statusMessage) for task polls. */
export async function startDurableFixture(): Promise<{
  definition: ServerDefinition;
  wire: Array<{ method: string }>;
  calls: Array<{ name: string; args: unknown }>;
  arm(): { eventId: string; nonce: string; a: number; b: number };
  toolValue: { nonce: string; value: number };
  close(): Promise<void>;
}> {
  const wire: Array<{ method: string }> = [], calls: Array<{ name: string; args: unknown }> = [];
  const toolValue = { nonce: randomBytes(16).toString("hex"), value: randomInt(10000000, 100000000) };
  const complete = (body: object) => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...body });
  const toolResult = () => complete({ content: [{ type: "text", text: JSON.stringify(toolValue) }], structuredContent: { ...toolValue } });
  let armed: { eventId: string; nonce: string; a: number; b: number } | undefined;
  let armedAt: string | undefined;
  const tasks = new Map<string, { createdAt: string; polls: number }>();
  const streams = new Map<string | number, ServerResponse>();
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
    let id: string | number | null = null;
    const error = (code: number, message: string) => res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const q = JSON.parse(raw), p = q.params ?? {};
      if (q.jsonrpc !== "2.0" || typeof q.method !== "string") { error(-32600, "Invalid request"); return; }
      id = q.id ?? null; wire.push({ method: q.method });
      if (q.id === undefined) {
        if (q.method === "notifications/cancelled") streams.get(p.requestId)?.end();
        res.writeHead(202).end(); return;
      }
      const result = (body: object) => res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, result: body }));
      switch (q.method) {
        case "server/discover":
          result(complete({ supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {}, prompts: {}, events: {},
            extensions: { "io.modelcontextprotocol/tasks": {} } } })); return;
        case "tools/list":
          result(complete({ tools: ["read_secret", "task_read"].map(name => ({ name,
            description: name === "read_secret" ? "Return a controlled unpredictable fixture value." : "Read the same fixture value through an MCP task.",
            inputSchema: { type: "object", properties: {} } })) })); return;
        case "tools/call": {
          if (!["read_secret", "task_read"].includes(p.name)) { error(-32602, "Unknown fixture tool"); return; }
          calls.push({ name: p.name, args: structuredClone(p.arguments ?? {}) });
          if (p.name === "read_secret") { result(toolResult()); return; }
          const taskId = randomUUID(), createdAt = new Date().toISOString();
          tasks.set(taskId, { createdAt, polls: 0 });
          result({ resultType: "task", taskId, status: "working", createdAt, lastUpdatedAt: createdAt, ttlMs: 60000, pollIntervalMs: 10 }); return;
        }
        case "tasks/get": {
          const task = tasks.get(p.taskId);
          if (!task) { error(-32001, "Unknown fixture task"); return; }
          task.polls++;
          result(complete({ taskId: p.taskId, status: "completed", statusMessage: `polls: ${task.polls}`, createdAt: task.createdAt,
            lastUpdatedAt: new Date().toISOString(), ttlMs: 60000, pollIntervalMs: 10, result: toolResult() })); return;
        }
        case "resources/list": result(complete({ resources: [] })); return;
        case "resources/templates/list": result(complete({ resourceTemplates: [] })); return;
        case "prompts/list": result(complete({ prompts: [] })); return;
        case "events/list":
          result(complete({ events: [{ name: "update", delivery: ["poll"], inputSchema: { type: "object", properties: {} },
            payloadSchema: { type: "object", required: ["nonce", "a", "b"], properties: {
              nonce: { type: "string" }, a: { type: "number" }, b: { type: "number" },
            } } }] })); return;
        case "events/poll":
          if (p.name !== "update") { error(-32602, "Unknown fixture event"); return; }
          result(complete({ events: armed ? [{ eventId: armed.eventId, name: "update", timestamp: armedAt,
            data: { nonce: armed.nonce, a: armed.a, b: armed.b }, cursor: armed.eventId }] : [],
          cursor: armed?.eventId ?? null, nextPollMs: 1000 })); return;
        case "subscriptions/listen": {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          streams.set(q.id, res);
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged",
            params: { notifications: p.notifications ?? {}, _meta: { "io.modelcontextprotocol/subscriptionId": q.id } } })}\n\n`);
          res.on("close", () => { if (streams.get(q.id) === res) streams.delete(q.id); }); return;
        }
        default: error(-32601, "Unsupported fixture method"); return;
      }
    } catch {
      if (!res.headersSent) error(-32700, "Invalid fixture request");
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); }); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
  let closeFlight: Promise<void> | undefined;
  return {
    definition: { url: `http://127.0.0.1:${address.port}/mcp`, auth: false, protocolVersion: "2026-07-28", tasks: true },
    wire, calls, toolValue,
    arm() {
      if (!armed) {
        armed = { eventId: randomUUID(), nonce: randomBytes(16).toString("hex"), a: randomInt(10000000, 100000000), b: randomInt(10000000, 100000000) };
        armedAt = new Date().toISOString();
      }
      return { ...armed };
    },
    close() {
      return closeFlight ??= new Promise<void>((resolve, reject) => {
        for (const stream of streams.values()) stream.end(); streams.clear();
        http.closeAllConnections(); http.close(error => { if (error) reject(error); else resolve(); });
      });
    },
  };
}
