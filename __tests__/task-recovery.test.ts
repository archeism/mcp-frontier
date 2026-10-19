import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { withSessionRecovery } from "../session-recovery.ts";
import { callToolViaTaskSession, type TaskToolCallOptions } from "../mcp-tasks.ts";
import { FileTaskRecoveryStore, TaskRecoveryBinding } from "../task-recovery-store.ts";
import { attachTaskSession } from "../mcp-tasks.ts";
import { toolDeclarationFromMcpTool } from "@modelcontextprotocol/ext-tasks/client";
import { ToolSchema } from "@modelcontextprotocol/core";

async function recoveryServer(dropHandle = false, plain = false) {
  let sessions = 0, invocations = 0, failedPoll = false;
  const wire: Array<{ method: string; session: string | undefined; params: any }> = [];
  const task = { taskId: "durable-1", status: "working", createdAt: "2026-10-16T00:00:00Z",
    lastUpdatedAt: "2026-10-16T00:00:00Z", ttl: 60000, pollInterval: 10 };
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const frame = JSON.parse(body), session = req.headers["mcp-session-id"] as string | undefined;
    wire.push({ method: frame.method, session, params: frame.params });
    if (frame.method === "server/discover") { res.writeHead(404).end("Legacy endpoint"); return; }
    const reply = (result: unknown, headers = {}) => res.writeHead(200, { "content-type": "application/json", ...headers })
      .end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    if (frame.method === "initialize") {
      reply({ protocolVersion: "2025-11-25", serverInfo: { name: "recovery", version: "1" },
        capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } } }, { "mcp-session-id": `s${++sessions}` }); return;
    }
    if (frame.id === undefined) { res.writeHead(202).end(); return; }
    if (session !== `s${sessions}`) { res.writeHead(404).end("Session not found"); return; }
    switch (frame.method) {
      case "tools/list": reply({ tools: [{ name: "work", inputSchema: { type: "object" }, execution: { taskSupport: plain ? "forbidden" : "optional" },
        outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } }] }); return;
      case "tools/call":
        invocations++;
        if (plain) { reply({ content: [], structuredContent: { count: 42 } }); return; }
        if (dropHandle) { req.socket.destroy(); return; }
        reply({ task }); return;
      case "tasks/get":
        if (!failedPoll) { failedPoll = true; res.writeHead(404).end("Session not found"); return; }
        reply({ ...task, status: "completed" }); return;
      case "tasks/result": reply({ content: [], structuredContent: { count: 42 } }); return;
      default: res.writeHead(500).end(`Unexpected ${frame.method}`);
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, wire,
    get invocations() { return invocations; }, get sessions() { return sessions; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

it("resumes a known task after polling HTTP 404 without a second original tool invocation", async () => {
  const fixture = await recoveryServer();
  const manager = new McpServerManager(process.cwd());
  const directory = await mkdtemp(join(tmpdir(), "task-recovery-"));
  const scope = { sessionId: "actual-pi-session", sessionFile: join(directory, "session.jsonl") };
  const store = new FileTaskRecoveryStore(scope);
  const config = { mcpServers: { demo: { url: fixture.url, auth: false as const, tasks: true } } };
  try {
    await manager.connect("demo", config.mcpServers.demo);
    const result = await withSessionRecovery({ manager, config }, "demo", connection =>
      callToolViaTaskSession(connection.taskSession!, { name: "work", args: {},
        meta: { "pi-mcp-adapter/toolCallId": "call-1" }, recovery: new TaskRecoveryBinding(store),
      } as TaskToolCallOptions));
    expect(result.structuredContent).toEqual({ count: 42 });
    expect(fixture.invocations).toBe(1);
    expect(fixture.sessions).toBe(2);
    expect(fixture.wire.filter(row => row.method === "tasks/get").map(row => row.session)).toEqual(["s1", "s2"]);
    expect(fixture.wire.find(row => row.method === "tools/call")?.params._meta["pi-mcp-adapter/toolCallId"]).toBe("call-1");
    const reopened = new FileTaskRecoveryStore(scope);
    try {
      const record = await reopened.read("call-1");
      expect(record).toMatchObject({ phase: "completed", reference: { taskId: "durable-1", generation: "v1" },
        declaration: { name: "work", outputSchema: { required: ["count"] } } });
      const connection = manager.getConnection("demo")!;
      const args = { name: "work", args: {}, meta: { "pi-mcp-adapter/toolCallId": "call-1" }, recovery: new TaskRecoveryBinding(reopened) };
      expect((await callToolViaTaskSession(connection.taskSession!, args)).structuredContent).toEqual({ count: 42 });
      await expect(callToolViaTaskSession(connection.taskSession!, { ...args, args: { changed: true } })).rejects.toThrow("intent does not match");
      expect(fixture.invocations).toBe(1);
      // A persisted result is still subject to its captured declaration.
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const corrupt = new DatabaseSync(scope.sessionFile + ".mcp-tasks/recovery.sqlite");
      try { corrupt.prepare("UPDATE tasks SET record=? WHERE session_id=? AND tool_call_id=?")
        .run(JSON.stringify({ ...record!, result: { content: [], structuredContent: { count: "tampered" } } }), scope.sessionId, "call-1"); }
      finally { corrupt.close(); }
      await expect(callToolViaTaskSession(connection.taskSession!, args)).rejects.toThrow(/output schema/i);
      const changed = await manager.reconnect("demo", { ...config.mcpServers.demo, headers: { Authorization: "Bearer test-only-binding" } }, connection);
      expect(changed.taskSession!.endpointId).not.toBe(connection.taskSession!.endpointId);
      await expect(callToolViaTaskSession(changed.taskSession!, args)).rejects.toThrow("intent does not match");
      expect(fixture.invocations).toBe(1);
    } finally { reopened.close(); }
  } finally { store.close(); await manager.closeAll(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

it("keeps ordinary legacy fallback output validation when replaying its durable result", async () => {
  const fixture = await recoveryServer(false, true), directory = await mkdtemp(join(tmpdir(), "task-plain-cache-"));
  const store = new FileTaskRecoveryStore({ sessionId: "pi-plain", sessionFile: join(directory, "session.jsonl") });
  const manager = new McpServerManager(process.cwd());
  try {
    const connection = await manager.connect("demo", { url: fixture.url, auth: false, tasks: true });
    const args = { name: "work", args: {}, meta: { "pi-mcp-adapter/toolCallId": "plain-call" }, recovery: new TaskRecoveryBinding(store) };
    expect((await callToolViaTaskSession(connection.taskSession!, args)).structuredContent).toEqual({ count: 42 });
    const record = (await store.read("plain-call"))!;
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const corrupt = new DatabaseSync(join(directory, "session.jsonl.mcp-tasks", "recovery.sqlite"));
    try { corrupt.prepare("UPDATE tasks SET record=? WHERE session_id=? AND tool_call_id=?")
      .run(JSON.stringify({ ...record, result: { content: [], structuredContent: { count: "wrong" } } }), "pi-plain", "plain-call"); }
    finally { corrupt.close(); }
    await expect(callToolViaTaskSession(connection.taskSession!, args)).rejects.toThrow(/output schema/i);
    expect(fixture.invocations).toBe(1);
  } finally { store.close(); await manager.closeAll(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

it("persists an uncertain intent when the creation response is lost and refuses reinvocation after restart", async () => {
  const fixture = await recoveryServer(true), directory = await mkdtemp(join(tmpdir(), "task-unknown-"));
  const scope = { sessionId: "pi-unknown", sessionFile: join(directory, "session.jsonl") };
  const store = new FileTaskRecoveryStore(scope), manager = new McpServerManager(process.cwd());
  const definition = { url: fixture.url, auth: false as const, tasks: true };
  try {
    const connection = await manager.connect("demo", definition);
    const args = { name: "work", args: {}, meta: { "pi-mcp-adapter/toolCallId": "lost-1" }, recovery: new TaskRecoveryBinding(store) };
    await expect(callToolViaTaskSession(connection.taskSession!, args)).rejects.toThrow();
    expect(await store.read("lost-1")).toMatchObject({ phase: "intent" });
    const reopened = new FileTaskRecoveryStore(scope);
    try {
      const fresh = await manager.reconnect("demo", definition, connection);
      await expect(callToolViaTaskSession(fresh.taskSession!, { ...args, recovery: new TaskRecoveryBinding(reopened) })).rejects.toThrow("outcome is unknown");
      expect(fixture.invocations).toBe(1);
    } finally { reopened.close(); }
  } finally { store.close(); await manager.closeAll(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

it("durable CAS isolates actual Pi sessions, rejects stale writers and scopes callbacks to their original owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-store-")), owner = new AbortController();
  const scope = { sessionId: "pi-a", sessionFile: join(directory, "session.jsonl"), signal: owner.signal };
  const a = new FileTaskRecoveryStore(scope), b = new FileTaskRecoveryStore(scope);
  const other = new FileTaskRecoveryStore({ ...scope, sessionId: "pi-b" });
  const record = { revision: 1, endpointId: "endpoint", name: "work", argumentsHash: "a".repeat(64), phase: "intent" as const, inputs: {} };
  try {
    expect(await Promise.all([a.compareAndSet("id", undefined, record), b.compareAndSet("id", undefined, record)]))
      .toEqual([true, false]);
    expect(await other.read("id")).toBeUndefined();
    owner.abort(new Error("Old Pi session closed"));
    await expect(a.compareAndSet("id", 1, { ...record, revision: 2 })).rejects.toThrow("Old Pi session closed");
  } finally { a.close(); b.close(); other.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(["acknowledged", "interrupted"] as const)("restores %s task input state after SDK resume without repeating approval", async inputState => {
  const directory = await mkdtemp(join(tmpdir(), "task-input-resume-"));
  const scope = { sessionId: "pi-input", sessionFile: join(directory, "session.jsonl") };
  const store = new FileTaskRecoveryStore(scope), manager = new McpServerManager(process.cwd());
  let polls = 0, approvals = 0, updates = 0, invocations = 0;
  const task = { taskId: "input-task", status: "working", createdAt: "2026-10-17T00:00:00Z",
    lastUpdatedAt: "2026-10-17T00:00:00Z", ttlMs: 60000, pollIntervalMs: 10 };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const frame = JSON.parse(body);
    const reply = (result: object) => res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    if (frame.method === "server/discover") { reply({ resultType: "complete", supportedVersions: ["2026-07-28"],
      capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } } }); return; }
    if (frame.method === "tools/list") { reply({ resultType: "complete", ttlMs: 0, cacheScope: "private",
      tools: [{ name: "work", inputSchema: { type: "object" } }] }); return; }
    if (frame.method === "tools/call") { invocations++; reply({ resultType: "task", ...task }); return; }
    expect(frame.params._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]).toEqual({});
    expect(req.headers["mcp-name"]).toBe(task.taskId);
    if (frame.method === "tasks/update") { updates++; reply({ resultType: "complete" }); return; }
    if (frame.method === "tasks/get") {
      polls++;
      if (polls === 2) { res.writeHead(404).end("Restart connection"); return; }
      if (polls <= 3) { reply({ resultType: "complete", ...task, status: "input_required", inputRequests: {
        approval: { method: "elicitation/create", params: { mode: "form", message: "Approve once", requestedSchema: { type: "object", properties: {} } } },
      } }); return; }
      reply({ resultType: "complete", ...task, status: "completed", result: { resultType: "complete", content: [{ type: "text", text: "done" }] } }); return;
    }
    res.writeHead(500).end(`Unexpected ${frame.method}`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const definition = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, auth: false as const,
    protocolVersion: "2026-07-28" as const, tasks: true };
  const attachments: Array<NonNullable<Awaited<ReturnType<typeof attachTaskSession>>>> = [];
  const attach = async (connection: Awaited<ReturnType<typeof manager.connect>>, binding: TaskRecoveryBinding) => {
    await connection.taskSession?.close();
    const attachment = await attachTaskSession({ client: connection.client, transport: connection.transport,
      serverName: "demo", definition, clientInfo: { name: "input-test", version: "1" }, clientCapabilities: { elicitation: { form: {} } },
      recovery: binding, tools: { currentTool: name => toolDeclarationFromMcpTool(ToolSchema.parse(connection.tools.find(tool => tool.name === name))) },
      onElicitation: async () => {
        expect(await binding.store.read("input-call")).toMatchObject({ phase: "task", reference: { taskId: task.taskId },
          inputs: { approval: { state: "started" } } });
        approvals++; return { action: "accept" as const, content: {} };
      },
    } as Parameters<typeof attachTaskSession>[0]);
    attachments.push(attachment!); return attachment!.session;
  };
  let reopened: FileTaskRecoveryStore | undefined;
  try {
    const connection = await manager.connect("demo", definition), first = new TaskRecoveryBinding(store);
    const session = await attach(connection, first);
    const args = { name: "work", args: {}, meta: { "pi-mcp-adapter/toolCallId": "input-call" }, recovery: first };
    await expect(callToolViaTaskSession(session, args)).rejects.toThrow();
    expect(approvals).toBe(1); expect(updates).toBe(1);
    reopened = new FileTaskRecoveryStore(scope);
    if (inputState === "interrupted") {
      const record = (await reopened.read("input-call"))!;
      const { response: _response, ...reserved } = record.inputs.approval!;
      await reopened.compareAndSet("input-call", record.revision, { ...record, revision: record.revision + 1,
        inputs: { approval: { ...reserved, state: "started" } } });
    }
    const binding = new TaskRecoveryBinding(reopened), fresh = await manager.reconnect("demo", definition, connection);
    const resumed = await attach(fresh, binding);
    if (inputState === "interrupted") await expect(callToolViaTaskSession(resumed, { ...args, recovery: binding })).rejects.toThrow("input outcome is unknown");
    else expect(await callToolViaTaskSession(resumed, { ...args, recovery: binding })).toMatchObject({ content: [{ text: "done" }] });
    expect(approvals).toBe(1); expect(updates).toBe(1); expect(invocations).toBe(1);
  } finally {
    for (const attachment of attachments) { attachment.channel.rejectAll("Test complete"); await attachment.session.close(); }
    reopened?.close(); store.close(); await manager.closeAll();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
});
