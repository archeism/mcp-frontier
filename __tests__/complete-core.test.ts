import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CoreClient, CORE_PROTOCOL, CORE_ACK_TIMEOUT_MS, installCore } from "../mcp-core.ts";
import { createProtocolSession, type McpProtocolSession } from "../runtime-protocol.ts";
import { McpServerManager } from "../server-manager.ts";
import { createMcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } from "../index.ts";

function session(overrides: Partial<McpProtocolSession> = {}): McpProtocolSession {
  const owner = new AbortController();
  return { signal: owner.signal, protocolVersion: "2026-07-28", serverCapabilities: { tools: {}, resources: { subscribe: true }, prompts: {}, completions: {}, logging: {} },
    request: vi.fn(async () => ({})), close: () => owner.abort(),
    watchNotifications: vi.fn(() => ({ closed: new Promise(() => {}), close: vi.fn() })),
    openStream: vi.fn((_method, params, receive) => {
      queueMicrotask(() => receive("notifications/subscriptions/acknowledged", { notifications: params.notifications }));
      return { id: "wire-1", sent: Promise.resolve(), closed: new Promise(() => {}), cancel: vi.fn(async () => {}) };
    }), ...overrides };
}

describe("core model-facing protocol", () => {
  it("follows all list pages and rejects repeated cursors", async () => {
    for (const [method, field] of Object.entries({ "tools/list": "tools", "resources/list": "resources", "resources/templates/list": "resourceTemplates", "prompts/list": "prompts" })) {
      const request = vi.fn().mockResolvedValueOnce({ [field]: [1], nextCursor: "next" }).mockResolvedValueOnce({ [field]: [2] });
      expect(await new CoreClient(session({ request })).execute(method)).toEqual({ [field]: [1, 2] });
      expect(request.mock.calls[1]?.[1]).toEqual({ cursor: "next" });
      request.mockReset().mockResolvedValue({ [field]: [], nextCursor: "loop" });
      await expect(new CoreClient(session({ request })).execute(method)).rejects.toThrow("Repeated");
      expect(request).toHaveBeenCalledTimes(2);
    }
  });
  it("bounds pagination even when every cursor differs", async () => {
    let cursor = 0;
    const request = vi.fn(async () => ({ tools: [], nextCursor: String(++cursor) }));
    await expect(new CoreClient(session({ request })).execute("tools/list")).rejects.toThrow("limit");
    expect(cursor).toBe(1000);
  });
  it("dispatches supported requests, rejects undeclared capabilities and arbitrary methods", async () => {
    const s = session(), c = new CoreClient(s);
    for (const action of ["ping", "resources/read", "prompts/get", "completion/complete", "logging/setLevel"])
      await c.execute(action, { value: action });
    expect(s.request).toHaveBeenCalledTimes(5);
    await expect(c.execute("tools/call")).rejects.toThrow("Unsupported");
    await expect(new CoreClient(session({ serverCapabilities: {} })).execute("resources/read")).rejects.toThrow("declare");
    const abort = new AbortController(); abort.abort();
    await expect(c.execute("ping", {}, abort.signal)).rejects.toThrow();
  });
  it("opens modern resource streams, cancels by id and retains bounded notifications", async () => {
    const s = session({ serverCapabilities: { resources: {} } }), deliver = vi.fn(), c = new CoreClient(s, deliver);
    const result = await c.execute("resources/subscribe", { uri: "fixture://readme" }) as { id: string };
    expect(s.openStream).toHaveBeenCalledWith("subscriptions/listen", { notifications: { resourceSubscriptions: ["fixture://readme"] } }, expect.any(Function));
    const receive = vi.mocked(s.openStream).mock.calls[0]![2];
    for (let i = 0; i < 205; i++) receive("notifications/progress", { progress: i });
    expect(c.records).toHaveLength(200);
    expect(deliver).toHaveBeenCalledTimes(206);
    await c.execute("resources/unsubscribe", { id: result.id });
    expect((await vi.mocked(s.openStream).mock.results[0]!.value).cancel).toHaveBeenCalledOnce();
    expect(c.status().watches).toEqual([]);
  });
  it("uses legacy subscribe RPC and local notification observation", async () => {
    const s = session({ protocolVersion: "2025-11-25" }), c = new CoreClient(s);
    await c.execute("resources/subscribe", { uri: "fixture://readme" });
    await c.execute("resources/unsubscribe", { uri: "fixture://readme" });
    await c.execute("watch");
    expect(s.openStream).not.toHaveBeenCalled();
    expect(s.watchNotifications).toHaveBeenCalledOnce();
    expect(s.request).toHaveBeenCalledWith("resources/subscribe", { uri: "fixture://readme" }, undefined);
    await expect(new CoreClient(session({ protocolVersion: "2025-11-25", serverCapabilities: { resources: {} } })).execute("resources/subscribe", { uri: "fixture://readme" })).rejects.toThrow("resource subscriptions");
  });
  it("waits for acknowledgement and reports the server's honored subset", async () => {
    let receive!: (method: string, params: Record<string, unknown>) => void;
    const s = session({ openStream: vi.fn((_method, _params, handler) => {
      receive = handler;
      return { id: "wire", sent: Promise.resolve(), closed: new Promise(() => {}), cancel: vi.fn(async () => {}) };
    }) });
    const c = new CoreClient(s);
    let finished = false;
    const pending = c.watch({ notifications: { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ["a", "b"] } }).then(value => { finished = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    expect(c.status().watches[0]?.state).toBe("starting");
    const honored = { toolsListChanged: true, resourceSubscriptions: ["b"] };
    receive("notifications/subscriptions/acknowledged", { notifications: honored });
    expect(await pending).toMatchObject({ notifications: honored });
    expect(c.status().watches[0]).toMatchObject({ state: "active", notifications: honored });
    await c.stop();
  });
  it.each([
    ["notifications/subscriptions/acknowledged", {}],
    ["notifications/subscriptions/acknowledged", { notifications: { toolsListChanged: "yes" } }],
    ["notifications/subscriptions/acknowledged", { notifications: { promptsListChanged: true } }],
    ["notifications/subscriptions/acknowledged", { notifications: { resourceSubscriptions: ["other"] } }],
    ["notifications/resources/updated", { uri: "a" }],
  ])("rejects an invalid first stream notification (%s, %j)", async (method, params) => {
    const cancel = vi.fn(async () => {}), close = vi.fn();
    const s = session({
      watchNotifications: vi.fn(() => ({ closed: new Promise(() => {}), close })),
      openStream: vi.fn((_method, _params, receive) => {
        queueMicrotask(() => receive(method as string, params as Record<string, unknown>));
        return { id: "wire", sent: Promise.resolve(), closed: new Promise(() => {}), cancel };
      }),
    });
    const c = new CoreClient(s);
    await expect(c.watch({ notifications: { toolsListChanged: true, resourceSubscriptions: ["a"] } })).rejects.toThrow();
    expect(cancel).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
    expect(c.status().watches).toEqual([]);
    expect(c.records).toEqual([]);
  });
  it("times out and releases streams whose server never acknowledges", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => {}), close = vi.fn();
      const c = new CoreClient(session({
        watchNotifications: vi.fn(() => ({ closed: new Promise(() => {}), close })),
        openStream: vi.fn(() => ({ id: "wire", sent: Promise.resolve(), closed: new Promise(() => {}), cancel })),
      }));
      const rejected = expect(c.watch({})).rejects.toThrow("Timed out");
      await vi.advanceTimersByTimeAsync(CORE_ACK_TIMEOUT_MS);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(c.status().watches).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(["call", "session"])("cancels promptly before acknowledgement on %s abort", async kind => {
    const cancel = vi.fn(async () => {}), abort = new AbortController();
    const s = session({ openStream: vi.fn(() => ({ id: "wire", sent: Promise.resolve(), closed: new Promise(() => {}), cancel })) });
    const c = new CoreClient(s);
    const rejected = expect(c.watch({}, abort.signal)).rejects.toThrow("cancelled");
    if (kind === "call") abort.abort(); else c.close();
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(c.status().watches).toEqual([]);
  });
  it("rejects stream errors before acknowledgement without waiting for the timeout", async () => {
    const c = new CoreClient(session({ openStream: vi.fn(() => ({ id: "wire", sent: Promise.resolve(), closed: Promise.resolve({ reason: "error", error: "Method not found" }), cancel: vi.fn(async () => {}) })) }));
    await expect(c.watch({})).rejects.toThrow("Method not found");
    expect(c.status().watches).toEqual([]);
  });
  it("cancels watch on abort and closes its session", async () => {
    const s = session(), c = new CoreClient(s), abort = new AbortController();
    await c.execute("watch", {}, abort.signal);
    abort.abort();
    expect(vi.mocked(s.openStream).mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
    c.close(); expect(s.signal.aborted).toBe(true);
  });
  it("sends tools/call exclusively through adapter approval/task bridge", async () => {
    let tool: any;
    const events = { emit: vi.fn((name, request) => {
      expect(name).toBe(MCP_RUNTIME_TOOL_CALL_EVENT);
      request.result = Promise.resolve({ ok: true, result: { content: [{ type: "text", text: "task result" }], details: { task: true } } });
    }) };
    installCore({ registerTool: (value: unknown) => { tool = value; }, events, on: vi.fn() } as unknown as ExtensionAPI);
    expect(tool.name).toBe("mcp_protocol");
    const result = await tool.execute("id", { server: "configured", action: "tool/call", params: { name: "task", arguments: { x: 1 } } });
    expect(result.details).toEqual({ task: true });
    expect(events.emit.mock.calls[0]?.[1]).toMatchObject({ server: "configured", tool: "task", args: { x: 1 } });
    events.emit.mockImplementation((_name, request) => { request.result = Promise.resolve({ ok: false, error: new Error("Approval denied") }); });
    expect((await tool.execute("id", { server: "configured", action: "tools/call", params: { name: "task" } })).isError).toBe(true);
  });
  it("forwards the tool signal and reports cancellation without dispatching pre-aborted calls", async () => {
    let tool: any;
    const controller = new AbortController();
    const events = { emit: vi.fn((_name, request) => {
      expect(request.signal).toBe(controller.signal);
      request.result = new Promise(resolve => request.signal.addEventListener("abort", () => resolve({ ok: false, error: request.signal.reason }), { once: true }));
    }) };
    installCore({ registerTool: (value: unknown) => { tool = value; }, events, on: vi.fn() } as unknown as ExtensionAPI);
    const input = { server: "configured", action: "tools/call", params: { name: "pending_task" } };
    const pending = tool.execute("id", input, controller.signal);
    controller.abort(new Error("cancel from model tool"));
    expect(await pending).toMatchObject({ isError: true, content: [{ text: "Error: cancel from model tool" }] });
    expect((await tool.execute("id", input, controller.signal)).isError).toBe(true);
    expect(events.emit).toHaveBeenCalledOnce();
  });
  it("keeps legacy discovery honest and includes negotiated identity/instructions", async () => {
    const s = session({ protocolVersion: "2025-11-25", serverInfo: { name: "legacy", version: "1" }, instructions: "server instructions" });
    expect(await new CoreClient(s).execute("discover")).toMatchObject({ source: "negotiated connection metadata", refreshed: false, message: expect.stringContaining("unsupported"), serverInfo: { name: "legacy", version: "1" }, instructions: "server instructions" });
    expect(s.request).not.toHaveBeenCalled();
  });
  it("refreshes modern discovery through the mediated request with cancellation", async () => {
    const request = vi.fn(async () => ({ supportedVersions: ["2026-07-28"], capabilities: { resources: {} } }));
    const abort = new AbortController(), c = new CoreClient(session({ request }));
    expect(await c.execute("discover", {}, abort.signal)).toMatchObject({ source: "server/discover", refreshed: true, supportedVersions: ["2026-07-28"] });
    expect(request).toHaveBeenCalledWith("server/discover", {}, abort.signal);
  });
  it("delegates task controls exclusively through taskRequest and guards task pagination", async () => {
    const taskRequest = vi.fn(async () => ({})), request = vi.fn(async () => ({}));
    const c = new CoreClient(session({ taskRequest, request })), abort = new AbortController();
    for (const action of ["tasks/get", "tasks/result", "tasks/cancel", "tasks/update"])
      await c.execute(action, { taskId: "id", inputResponses: {} }, abort.signal);
    expect(taskRequest).toHaveBeenCalledTimes(4); expect(request).not.toHaveBeenCalled();
    taskRequest.mockReset().mockResolvedValueOnce({ tasks: [1], nextCursor: "next" }).mockResolvedValueOnce({ tasks: [2] });
    expect(await c.execute("tasks/list")).toEqual({ tasks: [1, 2] });
    taskRequest.mockReset().mockResolvedValue({ tasks: [], nextCursor: "loop" });
    await expect(c.execute("tasks/list")).rejects.toThrow("Repeated Tasks");
    await expect(new CoreClient(session()).execute("tasks/get", { taskId: "id" })).rejects.toThrow("unavailable");
  });
  it("uses SDK discovery/controller APIs, snapshots metadata, and joins cancellation signals", async () => {
    const serverInfo = { name: "sdk", version: "1" }, owner = new AbortController();
    const snapshot = vi.fn(async () => ({})), result = vi.fn(async () => ({})), updateJson = vi.fn(async () => {});
    const taskSession = { capabilities: { execution: true, cancellation: true, inputResponses: true, inventory: "server-list" }, task: vi.fn(() => ({ snapshot, result, updateJson })), cancelTask: vi.fn(async () => {}), listTasks: vi.fn(async () => ({ tasks: [] })) };
    const client = { getServerVersion: () => serverInfo, getInstructions: () => "instructions", discover: vi.fn(async () => ({ supportedVersions: ["2026-07-28"], capabilities: {} })), request: vi.fn() };
    const connection = { status: "connected", transport: {}, client, taskSession } as any;
    const s = createProtocolSession(connection, owner.signal, CORE_PROTOCOL), abort = new AbortController();
    expect(s.serverInfo).toEqual(serverInfo); s.serverInfo!.name = "mutated";
    expect(serverInfo.name).toBe("sdk"); expect(s.instructions).toBe("instructions");
    await s.request("server/discover", {}, abort.signal);
    const discoverySignal = client.discover.mock.calls[0]![0]!.signal;
    expect(discoverySignal.aborted).toBe(false);
    for (const action of ["tasks/list", "tasks/get", "tasks/result", "tasks/update", "tasks/cancel"] as const)
      await s.taskRequest!(action, { taskId: "id", inputResponses: {} }, abort.signal);
    expect(taskSession.listTasks).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(snapshot).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(result).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(updateJson).toHaveBeenCalledWith({}, expect.any(AbortSignal));
    expect(taskSession.cancelTask).toHaveBeenCalledWith("id", expect.any(AbortSignal));
    result.mockResolvedValueOnce({ status: "failed", error: Object.assign(new Error("task failed"), { code: -32000, data: { detail: "fixture" } }) });
    expect(await s.taskRequest!("tasks/result", { taskId: "id" })).toMatchObject({ status: "failed", error: { message: "task failed", code: -32000, data: { detail: "fixture" } } });
    expect(client.request).not.toHaveBeenCalled();
    await expect(s.request("tasks/get", { taskId: "id" })).rejects.toThrow("Undeclared");
    await expect(s.request("server/discover", { arbitrary: true })).rejects.toThrow("does not accept");
    abort.abort(); expect(discoverySignal.aborted).toBe(true);
    owner.abort(); expect(s.signal.aborted).toBe(true); expect(connection.activeProtocolOperations).toBe(0);
  });
});

it("real adapter bridge cancels a model-facing task on the wire", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-core-cancel-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  const listeners = new Map<string, Array<(data: any) => void>>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools = new Map<string, any>();
  let active: string[] = [];
  const api = {
    events: {
      on: (name: string, handler: (data: any) => void) => {
        const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list);
        return () => listeners.set(name, list.filter(item => item !== handler));
      },
      emit: (name: string, data: any) => { for (const handler of listeners.get(name) ?? []) handler(data); },
    },
    on: (name: string, handler: (...args: any[]) => unknown) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool: (tool: any) => { tools.set(tool.name, tool); }, unregisterTool: (name: string) => tools.delete(name),
    registerFlag: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(), getFlag: vi.fn(),
    getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    sendMessage: vi.fn(), appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  const context = { cwd: directory, hasUI: false, mode: "print", sessionManager: { getBranch: () => [] } };
  try {
    createMcpAdapter({ config: {
      mcpServers: { core: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/complete-server.mjs", import.meta.url)), "stdio", "modern"], protocolVersion: "2026-07-28", tasks: true } },
      settings: { sampling: false, elicitation: false, approveTools: false, deferWithMissingMetadata: true, namespaceProxyTools: false },
    } })(api);
    installCore(api);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    const tool = tools.get("mcp_protocol");
    const invoke = (name: string, signal?: AbortSignal) => tool.execute("id", { server: "core", action: "tools/call", params: { name } }, signal);
    const inspect = async () => {
      const result = await invoke("inspect");
      expect(result.isError).not.toBe(true);
      return JSON.parse(result.content.find((block: any) => block.type === "text").text) as { log: Array<{ method: string; params: any }> };
    };
    await inspect(); // Finish lazy initialization before starting the cancellable task.
    const abort = new AbortController();
    const pending = invoke("pending_task", abort.signal);
    await expect.poll(async () => (await inspect()).log.some(row => row.method === "tasks/get")).toBe(true);
    abort.abort(new Error("cancel model-facing task"));
    expect(await pending).toMatchObject({ isError: true });
    await expect.poll(async () => (await inspect()).log.some(row => row.method === "tasks/cancel" && row.params.taskId === "task-1")).toBe(true);
    expect((await invoke("echo")).isError).not.toBe(true);
  } finally {
    try { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context); }
    finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  }
}, 20000);

for (const profile of ["modern", "legacy"] as const) it(`real SDK stdio ${profile}: lists, reads, prompts and subscription lifecycle`, async () => {
  const manager = new McpServerManager(process.cwd()), owner = new AbortController();
  try {
    const fixture = fileURLToPath(new URL("./fixtures/complete-server.mjs", import.meta.url));
    const connection = await manager.connect("core", { command: process.execPath, args: [fixture, "stdio", profile], protocolVersion: profile === "modern" ? "2026-07-28" : "auto" });
    const c = new CoreClient(createProtocolSession(connection, owner.signal, CORE_PROTOCOL));
    expect(c.status().protocolVersion).toBe(profile === "modern" ? "2026-07-28" : "2025-11-25");
    if (profile === "modern") {
      expect(await c.execute("discover")).toMatchObject({ refreshed: true, supportedVersions: ["2026-07-28"] });
      expect(connection.client.getDiscoverResult()).toMatchObject({ supportedVersions: ["2026-07-28"] });
    } else {
      const discovery = await c.execute("discover");
      expect(discovery).toMatchObject({ refreshed: false, serverInfo: { name: "complete-fixture", version: "1" } });
      const inspected = await connection.client.callTool({ name: "inspect", arguments: {} });
      expect(JSON.parse((inspected.content[0] as { text: string }).text).log.some((row: any) => row.method === "server/discover")).toBe(false);
    }
    expect(await c.execute("resources/list")).toMatchObject({ resources: [{ uri: "fixture://readme" }] });
    expect(await c.execute("resources/read", { uri: "fixture://readme" })).toMatchObject({ contents: [{ text: "fixture resource" }] });
    expect(await c.execute("prompts/get", { name: "greet" })).toMatchObject({ messages: [{ content: { text: "fixture prompt" } }] });
    expect(await c.execute("resources/templates/list")).toMatchObject({ resourceTemplates: [] });
    expect(await c.execute("tools/list")).toHaveProperty("tools");
    expect(await c.execute("prompts/list")).toHaveProperty("prompts");
    await c.execute("watch");
    expect(await c.execute("completion/complete", { ref: { type: "ref/prompt", name: "greet" }, argument: { name: "name", value: "fi" } })).toMatchObject({ completion: { values: ["fixture"], total: 1, hasMore: false } });
    await expect.poll(() => c.records.some(record => record.method === "notifications/progress" && record.params.message === "fixture progress")).toBe(true);
    if (profile === "legacy") {
      expect(await c.execute("ping")).toEqual({});
      expect(await c.execute("logging/setLevel", { level: "info" })).toEqual({});
      await expect.poll(() => c.records.some(record => record.method === "notifications/message" && record.params.data === "fixture log")).toBe(true);
      expect(c.records.some(record => record.method === "notifications/progress" && record.params.message === "fixture logging progress")).toBe(true);
    } else {
      // These methods are absent from the SDK's modern request registry.
      await expect(c.execute("ping")).rejects.toMatchObject({ code: "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION" });
      await expect(c.execute("logging/setLevel", { level: "info" })).rejects.toMatchObject({ code: "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION" });
    }
    const wire = await connection.client.callTool({ name: "inspect", arguments: {} });
    const rows = JSON.parse((wire.content[0] as { text: string }).text).log as Array<{ method: string; params?: any }>;
    const completion = rows.find(row => row.method === "completion/complete")!;
    expect(completion.params).toMatchObject({ ref: { type: "ref/prompt", name: "greet" }, argument: { name: "name", value: "fi" } });
    if (profile === "modern") {
      expect(completion.params._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
      expect(rows.some(row => row.method === "ping" || row.method === "logging/setLevel")).toBe(false);
    } else {
      expect(rows.some(row => row.method === "ping")).toBe(true);
      expect(rows.find(row => row.method === "logging/setLevel")?.params).toMatchObject({ level: "info" });
      expect(completion.params._meta?.["io.modelcontextprotocol/protocolVersion"]).toBeUndefined();
    }
    if (profile === "modern") {
      expect(c.records.some(r => r.method === "notifications/subscriptions/acknowledged")).toBe(true);
      expect(await c.execute("resources/subscribe", { uri: "fixture://readme" })).toMatchObject({ notifications: { resourceSubscriptions: ["fixture://readme"] } });
    }
    await c.execute("stop"); c.close();
    expect(connection.activeProtocolOperations).toBe(0);
  } finally { owner.abort(); await manager.closeAll(); }
}, 15000);

for (const profile of ["modern", "legacy"] as const) it(`real HTTP ${profile}: fresh discovery and metadata`, async () => {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls.push(request.method);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const frame = (value: Record<string, unknown>) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...value }));
    if (request.method === "server/discover" && profile === "modern") {
      frame({ result: { resultType: "complete", ttlMs: 0, cacheScope: "private", supportedVersions: ["2026-07-28"], capabilities: {}, instructions: "wire instructions", _meta: { "io.modelcontextprotocol/serverInfo": { name: "discovery-wire", version: "1" } } } });
    } else if (request.method === "initialize" && profile === "legacy") {
      frame({ result: { protocolVersion: "2025-11-25", capabilities: {}, instructions: "legacy instructions", serverInfo: { name: "legacy-wire", version: "1" } } });
    } else frame({ error: { code: -32601, message: "Method not found" } });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const manager = new McpServerManager(process.cwd()), owner = new AbortController();
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected HTTP address");
    const connection = await manager.connect("discovery", { url: `http://127.0.0.1:${address.port}/mcp`, auth: false, protocolVersion: profile === "modern" ? "2026-07-28" : "auto" });
    const c = new CoreClient(createProtocolSession(connection, owner.signal, CORE_PROTOCOL));
    const count = calls.filter(method => method === "server/discover").length;
    const discovery = await c.execute("discover");
    if (profile === "modern") {
      expect(discovery).toMatchObject({ refreshed: true, supportedVersions: ["2026-07-28"], instructions: "wire instructions" });
      expect(calls.filter(method => method === "server/discover")).toHaveLength(count + 1);
      expect(connection.client.getDiscoverResult()).toMatchObject({ instructions: "wire instructions" });
      await c.execute("server/discover");
      expect(calls.filter(method => method === "server/discover")).toHaveLength(count + 2);
      expect(c.status()).toMatchObject({ serverInfo: { name: "discovery-wire", version: "1" }, instructions: "wire instructions" });
    } else {
      expect(discovery).toMatchObject({ refreshed: false, serverInfo: { name: "legacy-wire", version: "1" }, instructions: "legacy instructions" });
      expect(calls.filter(method => method === "server/discover")).toHaveLength(count);
    }
    expect(connection.activeProtocolOperations ?? 0).toBe(0); c.close();
  } finally {
    owner.abort(); await manager.closeAll();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 15000);

it("real Tasks SDK manages known task IDs without raw request bypass", async () => {
  const manager = new McpServerManager(process.cwd()), owner = new AbortController();
  try {
    const fixture = fileURLToPath(new URL("./fixtures/complete-server.mjs", import.meta.url));
    const connection = await manager.connect("core-tasks", { command: process.execPath, args: [fixture, "stdio", "modern"], protocolVersion: "2026-07-28", tasks: true });
    const s = createProtocolSession(connection, owner.signal, CORE_PROTOCOL), c = new CoreClient(s);
    const tasks = connection.taskSession!;
    expect(c.status().taskCapabilities).toMatchObject({ execution: true, inventory: "known-handles" });
    // Seed existing tasks through the official SDK. Production creation remains on the approval bridge.
    const completed = await tasks.callTool("task", {});
    if (completed.kind !== "task") throw new Error("Expected task execution");
    await completed.detach();
    const taskId = completed.handle.taskId;
    expect(await c.execute("tasks/get", { taskId })).toMatchObject({ taskId });
    expect(await c.execute("tasks/result", { taskId })).toMatchObject({ status: "completed", result: { content: [{ text: "task done" }] } });
    const input = await tasks.callTool("input_task", {});
    if (input.kind !== "task") throw new Error("Expected input task");
    await input.detach();
    await c.execute("tasks/update", { taskId: input.handle.taskId, inputResponses: { roots: { roots: [{ uri: "fixture://manual" }] } } });
    expect(await c.execute("tasks/result", { taskId: input.handle.taskId })).toMatchObject({ status: "completed" });
    const pending = await tasks.callTool("pending_task", {});
    if (pending.kind !== "task") throw new Error("Expected pending task");
    await pending.detach();
    await c.execute("tasks/cancel", { taskId: pending.handle.taskId });
    const abort = new AbortController();
    const rejected = expect(c.execute("tasks/result", { taskId: pending.handle.taskId }, abort.signal)).rejects.toThrow();
    abort.abort(); await rejected;
    await expect(c.execute("tasks/list")).rejects.toThrow("inventory is unsupported");
    const inspected = await connection.client.callTool({ name: "inspect", arguments: {} });
    const log = JSON.parse((inspected.content[0] as { text: string }).text).log as Array<{ method: string; params: any }>;
    expect(log.some(row => row.method === "tasks/cancel" && row.params.taskId === pending.handle.taskId)).toBe(true);
    expect(log.some(row => row.method === "tasks/update" && row.params.inputResponses.roots.roots[0]?.uri === "fixture://manual")).toBe(true);
    expect(log.some(row => row.method === "tasks/list" || row.method === "tasks/result")).toBe(false); // V2 result is embedded in tasks/get.
    expect(connection.activeProtocolOperations).toBe(0);
    c.close();
  } finally { owner.abort(); await manager.closeAll(); }
}, 15000);
