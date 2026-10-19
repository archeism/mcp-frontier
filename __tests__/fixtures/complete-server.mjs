import http from "node:http";
import readline from "node:readline";

// Deliberately a wire fixture: the real adapter SDK must decode every response.
const mode = process.argv[2] ?? "stdio";
const profile = process.argv[3] ?? "modern";
const modern = profile !== "legacy";
const supported = profile !== "unsupported";
const log = [];
const tasks = new Map();
const streams = new Map();
const subscriptions = new Map();
const capabilities = {
  tools: {}, resources: {}, prompts: {}, completions: {}, logging: {},
  ...(supported ? { events: { listChanged: true }, extensions: { "io.modelcontextprotocol/tasks": {} } } : {}),
};
const complete = value => modern
  ? { resultType: "complete", ttlMs: 0, cacheScope: "private", ...value }
  : value;
const text = value => ({ content: [{ type: "text", text: value }], isError: false });

function dispatch(request, send, headers = {}) {
  log.push({ method: request.method, id: request.id, params: request.params, headers });
  const result = value => send({ jsonrpc: "2.0", id: request.id, result: value });
  const error = (code, message) => send({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  switch (request.method) {
    case "server/discover":
      return modern ? result({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities }) : error(-32601, "Legacy server");
    case "initialize":
      return result({ protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "complete-fixture", version: "1" } });
    case "subscriptions/listen":
      subscriptions.set(request.id, send);
      return send({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: {
        notifications: request.params?.notifications ?? {},
        _meta: { "io.modelcontextprotocol/subscriptionId": request.id },
      } });
    case "ping": return result(complete({}));
    case "completion/complete": {
      const progress = { progressToken: "fixture-progress", progress: 1, total: 1, message: "fixture progress" };
      if (modern) {
        for (const [id, notify] of subscriptions) notify({ jsonrpc: "2.0", method: "notifications/progress", params: { ...progress, _meta: { "io.modelcontextprotocol/subscriptionId": id } } });
      } else send({ jsonrpc: "2.0", method: "notifications/progress", params: progress });
      return result(complete({ completion: { values: ["fixture"], total: 1, hasMore: false } }));
    }
    case "logging/setLevel":
      send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", logger: "fixture", data: "fixture log" } });
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "fixture-logging-progress", progress: 1, total: 1, message: "fixture logging progress" } });
      return result(complete({}));
    case "tools/list":
      return result(complete({ tools: ["echo", "inspect", "task", "input_task", "pending_task", "emit"].map(name => ({ name, inputSchema: { type: "object", properties: {} } })) }));
    case "resources/list":
      return result(complete({ resources: [{ uri: "fixture://readme", name: "readme", mimeType: "text/plain" }] }));
    case "resources/templates/list":
      return result(complete({ resourceTemplates: [] }));
    case "resources/read":
      return result(complete({ contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "fixture resource" }] }));
    case "prompts/list":
      return result(complete({ prompts: [{ name: "greet" }] }));
    case "prompts/get":
      return result(complete({ messages: [{ role: "user", content: { type: "text", text: "fixture prompt" } }] }));
    case "events/list":
      return supported ? result(complete({ events: [{ name: "tick", delivery: ["push"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }] })) : error(-32601, "Events unsupported");
    case "events/stream": {
      if (!supported) return error(-32601, "Events unsupported");
      streams.set(request.id, send);
      return notify(request.id, "active", { cursor: "0" });
    }
    case "tools/call": {
      const { name, arguments: args = {} } = request.params;
      if (name === "inspect") return result(complete(text(JSON.stringify({ log, taskCount: tasks.size, streamIds: [...streams.keys()] }))));
      if (name === "emit") {
        const id = args.subscriptionId;
        notify(id, "event", { name: "tick", eventId: `event-${id}`, timestamp: new Date().toISOString(), cursor: "1", data: { value: args.value } });
        notify(id, "heartbeat", { cursor: "2" });
        if (args.terminate) {
          notify(id, "terminated", { error: { message: "fixture terminated" } });
          streams.get(id)?.({ jsonrpc: "2.0", id, result: complete({}) });
          streams.delete(id);
        }
        return result(complete(text("emitted")));
      }
      if (modern && supported && ["task", "input_task", "pending_task"].includes(name)) {
        const task = { taskId: `task-${tasks.size + 1}`, createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: 60000, pollIntervalMs: 5 };
        tasks.set(task.taskId, { task, name, polls: 0, updated: false });
        return result({ resultType: "task", ...task, status: "working" });
      }
      return result(complete(text("fixture echo")));
    }
    case "tasks/get": {
      const state = tasks.get(request.params.taskId);
      if (!state) return error(-32602, "Unknown task");
      state.polls++;
      const status = state.name === "pending_task" || state.polls === 1 ? "working" : "completed";
      if (state.name === "input_task" && !state.updated) return result(complete({ ...state.task, status: "input_required", inputRequests: { roots: { method: "roots/list", params: {} } } }));
      return result(complete({ ...state.task, status, ...(status === "completed" ? { result: complete(text("task done")) } : {}) }));
    }
    case "tasks/update":
      tasks.get(request.params.taskId).updated = true;
      return result(complete({}));
    case "tasks/cancel":
      tasks.get(request.params.taskId).cancelled = true;
      return result(complete({}));
    case "notifications/cancelled":
      streams.delete(request.params.requestId);
      subscriptions.delete(request.params.requestId);
      return;
    case "notifications/initialized": return;
    default: if (request.id !== undefined) return error(-32601, "Method not found");
  }
}
function notify(id, kind, params) {
  streams.get(id)?.({ jsonrpc: "2.0", method: `notifications/events/${kind}`, params: {
    ...params, _meta: { "io.modelcontextprotocol/subscriptionId": id },
  } });
}

if (mode === "stdio") {
  readline.createInterface({ input: process.stdin }).on("line", line => dispatch(JSON.parse(line), frame => process.stdout.write(`${JSON.stringify(frame)}\n`)));
} else {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.id === undefined) {
      dispatch(request, () => {}, req.headers);
      return res.writeHead(202).end();
    }
    if (["events/stream", "subscriptions/listen"].includes(request.method) && supported) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.on("close", () => { streams.delete(request.id); subscriptions.delete(request.id); });
      dispatch(request, frame => {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
        if (frame.id !== undefined) res.end();
      }, req.headers);
    } else if (["completion/complete", "logging/setLevel"].includes(request.method)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      dispatch(request, frame => { res.write(`data: ${JSON.stringify(frame)}\n\n`); if (frame.id !== undefined) res.end(); }, req.headers);
    } else dispatch(request, frame => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(frame)), req.headers);
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp` })}\n`));
}
