import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

/** Reusable localhost fixture for Pi/faux and real-model verification.
 * SDK owns legacy HTTP, JSON-RPC and peer requests. Extension tool-task results
 * and modern wire frames are controlled (no SDK Server receiver for tool tasks).
 * Evidence: wire[], inputs[], tasks Map, violations[]. No real credentials. */
export async function startTaskTrustServer({ era = "modern", correlation = "valid", requireResult = true, peerTimeoutMs = 2000, samplingMaxTokens = 100 } = {}) {
  const modern = era === "modern", wire = [], inputs = [], violations = [], tasks = new Map();
  const sdk = new Server({ name: "task-trust-fixture", version: "1" }, { capabilities: { tools: {},
    ...(modern ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : { tasks: { cancel: {}, requests: { tools: { call: {} } } } }) } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: modern ? undefined : randomUUID });
  const shape = state => ({ taskId: state.id, status: state.done ? "completed" : "input_required",
    createdAt: "2026-10-17T00:00:00Z", lastUpdatedAt: "2026-10-17T00:00:00Z",
    ...(modern ? { ttlMs: 60000, pollIntervalMs: 10 } : { ttl: 60000, pollInterval: 10 }) });
  const input = state => ({ method: state.kind === "sampling" ? "sampling/createMessage" : "elicitation/create",
    params: state.kind === "sampling" ? { messages: [{ role: "user", content: { type: "text", text: `TASK_SAMPLE_${state.id}: Reply exactly TASK_SAMPLING_APPROVED_RESULT.` } }],
      maxTokens: samplingMaxTokens, includeContext: "none" } : { mode: "form", message: `TASK_ELICIT_${state.id}`, requestedSchema: { type: "object", properties: {} } } });
  const final = state => ({ content: [{ type: "text", text: JSON.stringify({ taskId: state.id, kind: state.kind, input: state.response }) }] });
  const peerInput = async (state, relatedRequestId) => {
    if (state.started) return state.flight;
    state.started = true;
    state.flight = (async () => {
      const evidence = correlation === "valid" ? { taskId: state.id } : correlation === "malformed" ? { taskId: 42 }
        : correlation === "cross-task" ? { taskId: state.id === "trust-1" ? "trust-2" : "trust-1" } : { taskId: "not-an-owned-task" };
      const request = input(state);
      if (correlation !== "missing") request.params._meta = { "io.modelcontextprotocol/related-task": evidence };
      try {
        // SDK validates the peer response and correlates its JSON-RPC id.
        state.response = state.kind === "sampling"
          ? await sdk.createMessage(request.params, { relatedRequestId, timeout: peerTimeoutMs })
          : await sdk.elicitInput(request.params, { relatedRequestId, timeout: peerTimeoutMs });
      } catch (error) { state.response = { protocolError: { code: error.code, message: error.message } }; }
      inputs.push({ taskId: state.id, request, response: state.response }); state.done = true;
    })();
    return state.flight;
  };
  sdk.setRequestHandler("tools/list", async () => ({ tools: ["sampling", "elicitation"].map(name => ({ name,
    inputSchema: { type: "object", properties: {} }, ...(modern ? {} : { execution: { taskSupport: "required" } }) })) }));
  const createTask = async request => {
    const kind = request.params.name;
    const state = { id: `trust-${tasks.size + 1}`, kind, done: false, started: false, polls: 0, resultRequests: 0 };
    tasks.set(state.id, state);
    return modern ? { resultType: "task", ...shape(state), status: "working" } : { task: { ...shape(state), status: "working" } };
  };
  sdk.setRequestHandler("tools/call", createTask);
  const taskRequest = async (request, ctx) => {
    const state = tasks.get(request.params?.taskId);
    if (!state) throw new Error("Unknown fixture task");
    if (request.method === "tasks/get") {
      state.polls++;
      if (!modern && !requireResult && tasks.size >= 2 && !state.started) void peerInput(state, ctx.mcpReq.id);
      return modern ? { resultType: "complete", ...shape(state), ...(state.done ? { result: { resultType: "complete", ...final(state) } } : { inputRequests: { input: input(state) } }) } : shape(state);
    }
    if (request.method === "tasks/update") {
      state.response = request.params.inputResponses.input; state.done = true;
      inputs.push({ taskId: state.id, request: input(state), response: state.response });
      return { resultType: "complete" };
    }
    if (request.method === "tasks/result") {
      state.resultRequests++;
      await peerInput(state, ctx.mcpReq.id);
      return { ...final(state), _meta: { "io.modelcontextprotocol/related-task": { taskId: state.id } } };
    }
    if (request.method === "tasks/cancel") { state.done = true; return modern ? { resultType: "complete" } : { ...shape(state), status: "cancelled" }; }
    throw new Error(`Unexpected ${request.method}`);
  };
  sdk.fallbackRequestHandler = taskRequest;
  await sdk.connect(transport);
  const receive = transport.onmessage;
  transport.onmessage = (frame, extra) => { wire.push({ direction: "client", frame }); receive?.(frame, extra); };
  const send = transport.send.bind(transport);
  transport.send = async (frame, options) => { wire.push({ direction: "server", frame }); return send(frame, options); };
  const http = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (req.headers.authorization !== "Bearer task-trust-fixture") { violations.push("missing fixture authentication"); res.writeHead(401).end(); return; }
      if (!modern && req.method === "POST") {
        const frame = JSON.parse(Buffer.concat(chunks).toString());
        if (frame.method === "tools/call") {
          // Core Server validates fixed tools/call output, not task handles.
          // Control only that extension result; SDK still owns the subsequent
          // task request streams and actual sampling/elicitation peer traffic.
          if (req.headers["mcp-session-id"] !== transport.sessionId) { res.writeHead(404).end(); return; }
          wire.push({ direction: "client", frame });
          const response = { jsonrpc: "2.0", id: frame.id, result: await createTask(frame) };
          wire.push({ direction: "server", frame: response });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response)); return;
        }
      }
      // The official base Server does not serve ext-tasks tool results. Modern
      // extension frames are controlled here, consumed by the real SDK client.
      // Legacy core/peer messages below continue through the official Server.
      if (modern) {
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        const frame = JSON.parse(Buffer.concat(chunks).toString()); wire.push({ direction: "client", frame });
        const meta = frame.params?._meta;
        if (meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" || !meta?.["io.modelcontextprotocol/clientInfo"]) violations.push("missing modern framing");
        let result;
        if (frame.method === "server/discover") result = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } } };
        else if (frame.method === "tools/list") result = { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: ["sampling", "elicitation"].map(name => ({ name, inputSchema: { type: "object", properties: {} } })) };
        else {
          if (!meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.["io.modelcontextprotocol/tasks"]) violations.push("missing task capability");
          if (frame.method.startsWith("tasks/") && (req.headers["mcp-name"] !== frame.params.taskId || req.headers["mcp-method"] !== frame.method)) violations.push("missing task routing");
          result = frame.method === "tools/call" ? await createTask(frame) : await taskRequest(frame, {});
        }
        const response = { jsonrpc: "2.0", id: frame.id, result }; wire.push({ direction: "server", frame: response });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response)); return;
      }
      const response = await transport.handleRequest(new Request(`http://127.0.0.1${req.url}`, { method: req.method,
        headers: req.headers, ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const reader = response.body?.getReader();
      if (reader) { res.on("close", () => { void reader.cancel().catch(() => {}); });
        for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); } }
      res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  return { era, url, definition: { url, auth: false, tasks: true, lifecycle: "eager",
    protocolVersion: modern ? "2026-07-28" : "legacy", headers: { Authorization: "Bearer task-trust-fixture" } },
    wire, inputs, tasks, violations,
    report() { return { schemaVersion: 1, protocolEra: era, taskCount: tasks.size,
      tasks: [...tasks.values()].map(state => ({ taskId: state.id, kind: state.kind, polls: state.polls,
        resultRequests: state.resultRequests, terminal: state.done, inputAction: state.response?.action,
        samplingReturned: state.kind === "sampling" && state.response?.content !== undefined })),
      clientMethods: wire.filter(row => row.direction === "client" && row.frame.method).map(row => row.frame.method),
      violations: [...violations] }; },
    async close() { await sdk.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); } };
}
