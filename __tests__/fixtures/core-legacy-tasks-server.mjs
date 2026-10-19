import http from "node:http";
import readline from "node:readline";

const mode = process.argv[2] ?? "stdio";
const modern = process.argv[3] === "loops";
let inputRounds = 0;
const tasks = new Map(), log = [];
const tools = ["optional", "required", "pending", "forbidden", "plain", "invalid", "inspect"].map(name => ({
  name, inputSchema: { type: "object", properties: {} },
  ...(["optional", "required", "pending", "forbidden"].includes(name) ? { execution: { taskSupport: name === "required" ? "required" : name === "forbidden" ? "forbidden" : "optional" } } : {}),
  ...(["plain", "invalid"].includes(name) ? { outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } : {}),
}));
const text = value => ({ content: [{ type: "text", text: value }] });
function dispatch(request, send) {
  log.push({ method: request.method, id: request.id, params: request.params });
  const result = value => send({ jsonrpc: "2.0", id: request.id, result: value });
  const error = message => send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message } });
  if (request.id === undefined) return;
  switch (request.method) {
    case "server/discover": return modern ? result({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } } }) : error("Legacy server");
    case "initialize": return result({ protocolVersion: "2025-11-25", capabilities: { tools: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, serverInfo: { name: "legacy-tasks", version: "1" } });
    case "tools/list": return result(modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "loops", inputSchema: { type: "object" } }] } : { tools });
    case "tools/call": {
      const { name, task } = request.params;
      if (name === "inspect") return result(text(JSON.stringify({ log })));
      if (modern) {
        const now = new Date().toISOString();
        return result({ resultType: "task", taskId: "input-loops", status: "working", createdAt: now, lastUpdatedAt: now, ttlMs: 60000, pollIntervalMs: 1 });
      }
      if (task !== undefined) {
        if (!["optional", "required", "pending"].includes(name)) return error("Tool forbids Tasks");
        const now = new Date().toISOString(), taskId = `legacy-${tasks.size + 1}`;
        const view = { taskId, status: "working", createdAt: now, lastUpdatedAt: now, ttl: 60000, pollInterval: 5 };
        tasks.set(taskId, { view, polls: 0, pending: name === "pending" });
        return result({ task: view });
      }
      if (name === "required") return error("Required task metadata missing");
      const ordinary = { ...text("ordinary"), ...(["plain", "invalid"].includes(name) ? { structuredContent: { value: name === "invalid" ? 42 : "ok" } } : {}) };
      if (name === "plain" && request.params._meta?.progressToken !== undefined) {
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: request.params._meta.progressToken, progress: 1, total: 1, message: "ordinary legacy progress" } });
        // Keep the operation active while the peer processes its progress notification.
        setTimeout(() => result(ordinary), 20);
        return;
      }
      return result(ordinary);
    }
    case "tasks/get": {
      if (modern) {
        const now = new Date().toISOString();
        return result({ resultType: "complete", taskId: "input-loops", createdAt: now, lastUpdatedAt: now, ttlMs: 60000, pollIntervalMs: 1,
          ...(inputRounds < 12 ? { status: "input_required", inputRequests: { [`round-${inputRounds}`]: { method: "roots/list", params: {} } } } : { status: "completed", result: { resultType: "complete", ...text("12 valid input rounds completed") } }),
        });
      }
      const state = tasks.get(request.params.taskId);
      if (!state) return error("Unknown task");
      if (++state.polls >= 2 && !state.pending && state.view.status === "working") state.view.status = "completed";
      return result(state.view);
    }
    case "tasks/update": inputRounds++; return result({ resultType: "complete" });
    case "tasks/result": return result(text("legacy task done"));
    case "tasks/cancel": {
      const state = tasks.get(request.params.taskId);
      if (!state) return error("Unknown task");
      state.view.status = "cancelled"; return result(state.view);
    }
    case "tasks/list": {
      const all = [...tasks.values()].map(state => state.view);
      return result(request.params?.cursor ? { tasks: all.slice(1) } : { tasks: all.slice(0, 1), ...(all.length > 1 ? { nextCursor: "page-2" } : {}) });
    }
    default: return error("Method not found");
  }
}
if (mode === "stdio") readline.createInterface({ input: process.stdin }).on("line", line => dispatch(JSON.parse(line), frame => process.stdout.write(JSON.stringify(frame) + "\n")));
else {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.id === undefined) { dispatch(request, () => {}); return res.writeHead(202).end(); }
    if (request.method === "tools/call" && request.params.name === "plain" && request.params._meta?.progressToken !== undefined) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return dispatch(request, frame => {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
        if (frame.id !== undefined) res.end();
      });
    }
    dispatch(request, frame => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(frame)));
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp` }) + "\n"));
}
