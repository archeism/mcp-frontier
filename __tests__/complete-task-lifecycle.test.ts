import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { Client, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "../index.ts";
import { installCore } from "../mcp-core.ts";
import { attachTaskSession, callToolViaTaskSession } from "../mcp-tasks.ts";

const extension = "io.modelcontextprotocol/tasks";
const task = { taskId: "lifecycle-task", status: "working", createdAt: "2026-10-16T00:00:00Z",
  lastUpdatedAt: "2026-10-16T00:00:00Z", ttlMs: 60000, pollIntervalMs: 10 };
const done = { resultType: "complete", content: [{ type: "text", text: "finished" }] };
const input = (message: string) => ({ method: "elicitation/create", params: {
  mode: "form", message, requestedSchema: { type: "object", properties: {} },
} });

/** Real HTTP + SDK + public mcp_protocol tools; only the Pi host and server are fixtures. */
async function lifecycleBridge(scenario: "replay" | "cancel") {
  const directory = await mkdtemp(join(tmpdir(), "mcp-task-lifecycle-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  const wire: Array<{ method: string; params: any }> = [];
  const violations: string[] = [], approvals: string[] = [], updates: string[][] = [];
  let polls = 0, complete = false, cancellations = 0, toolCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const frame = JSON.parse(body);
    wire.push({ method: frame.method, params: frame.params });
    const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    const fail = (message: string) => {
      violations.push(message);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: frame.id, error: { code: -32021, message },
      }));
    };
    if (req.headers.authorization !== "Bearer lifecycle-fixture") { fail("Missing fixture auth"); return; }
    const meta = frame.params?._meta;
    if (meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" ||
        typeof meta?.["io.modelcontextprotocol/clientInfo"]?.name !== "string") {
      fail("Missing modern request identity"); return;
    }
    if (frame.method.startsWith("tasks/") || frame.method === "tools/call") {
      if (JSON.stringify(meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.[extension]) !== "{}") {
        fail("Missing Tasks capability"); return;
      }
    }
    if (frame.method.startsWith("tasks/") && (req.headers["mcp-name"] !== task.taskId ||
        req.headers["mcp-method"] !== frame.method || frame.params.taskId !== task.taskId)) {
      fail("Invalid task routing"); return;
    }
    const envelope = (value: object) => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...value });
    switch (frame.method) {
      case "server/discover": reply({ resultType: "complete", supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, extensions: { [extension]: {} } } }); return;
      case "tools/list": reply(envelope({ tools: [{ name: "work", inputSchema: { type: "object" } }] })); return;
      case "resources/list": reply(envelope({ resources: [] })); return;
      case "resources/templates/list": reply(envelope({ resourceTemplates: [] })); return;
      case "prompts/list": reply(envelope({ prompts: [] })); return;
      case "tools/call": toolCalls++; reply({ resultType: "task", ...task }); return;
      case "tasks/get": {
        polls++;
        if (complete || (scenario === "replay" && polls >= 5)) {
          reply({ resultType: "complete", ...task, status: "completed", result: done }); return;
        }
        if (scenario === "replay") {
          reply({ resultType: "complete", ...task, status: "input_required", inputRequests: {
            first: input("first request"), ...(polls >= 3 ? { second: input("second request") } : {}),
          } }); return;
        }
        reply({ resultType: "complete", ...task }); return;
      }
      case "tasks/update": updates.push(Object.keys(frame.params.inputResponses)); reply({ resultType: "complete" }); return;
      case "tasks/cancel": cancellations++; reply({ resultType: "complete" }); return;
      default:
        if (frame.id === undefined) res.writeHead(202).end();
        else fail(`Unexpected method ${frame.method}`);
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const listeners = new Map<string, Array<(data: any) => void>>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools = new Map<string, any>(); let active: string[] = [];
  const api = {
    events: {
      on(name: string, handler: (data: any) => void) {
        const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list);
        return () => listeners.set(name, list.filter(item => item !== handler));
      },
      emit(name: string, data: any) { for (const handler of listeners.get(name) ?? []) handler(data); },
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool), unregisterTool: (name: string) => tools.delete(name),
    registerFlag: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(), getFlag: vi.fn(),
    getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    sendMessage: vi.fn(), appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  const context = { cwd: directory, hasUI: true, mode: "print", sessionManager: { getBranch: () => [] },
    ui: { select: async (title: string) => { approvals.push(title); return "Continue"; },
      confirm: async () => true, notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } };
  createMcpAdapter({ config: {
    mcpServers: { lifecycle: { url: `http://127.0.0.1:${address.port}/mcp`, auth: false,
      headers: { Authorization: "Bearer lifecycle-fixture" }, protocolVersion: "2026-07-28", tasks: true } },
    settings: { sampling: false, elicitation: true, approveTools: false, deferWithMissingMetadata: true, namespaceProxyTools: false },
  } })(api);
  installCore(api);
  for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
  return {
    wire, violations, approvals, updates,
    get polls() { return polls; }, get cancellations() { return cancellations; }, get toolCalls() { return toolCalls; },
    finish() { complete = true; },
    invoke(action: string, params: object = {}) {
      return tools.get("mcp_protocol").execute("lifecycle-call", { server: "lifecycle", action, params });
    },
    async close() {
      try { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context); }
      finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

it("production HTTP bridge deduplicates replayed task inputs after update acknowledgements and handles new keys", async () => {
  const f = await lifecycleBridge("replay");
  try {
    const result = await f.invoke("tools/call", { name: "work", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("finished");
    expect(f.polls).toBe(5);
    expect(f.approvals.filter(title => title.includes("first request"))).toHaveLength(1);
    expect(f.approvals.filter(title => title.includes("second request"))).toHaveLength(1);
    expect(f.updates).toEqual([["first"], ["second"]]);
    expect(f.toolCalls).toBe(1);
    expect(f.violations).toEqual([]);
  } finally { await f.close(); }
}, 15000);

it("production HTTP bridge separates local cancellation from working server state and later completion", async () => {
  const f = await lifecycleBridge("cancel");
  try {
    const pending = f.invoke("tools/call", { name: "work", arguments: {} });
    await expect.poll(() => f.polls).toBeGreaterThan(0);
    expect((await f.invoke("tasks/cancel", { taskId: task.taskId })).isError).not.toBe(true);
    expect(f.cancellations).toBe(1);
    const status = await f.invoke("tasks/get", { taskId: task.taskId });
    expect(status.isError).not.toBe(true);
    expect(JSON.parse(status.content.find((block: any) => block.type === "text").text)).toMatchObject({
      taskId: task.taskId, status: "working",
    });
    // Ending the local execution is allowed; it is not a server terminal snapshot.
    expect(await pending).toMatchObject({ isError: true });
    f.finish();
    const result = await f.invoke("tasks/result", { taskId: task.taskId });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content.find((block: any) => block.type === "text").text)).toMatchObject({
      status: "completed", result: { content: [{ text: "finished" }] },
    });
    expect(f.toolCalls).toBe(1);
    expect(f.wire.some(frame => frame.method === "notifications/cancelled")).toBe(false);
    expect(f.violations).toEqual([]);
  } finally { await f.close(); }
}, 15000);

it("production task-call bridge honors increased, decreased and removed polling hints through the real SDK", async () => {
  const polls: number[] = [], methods: string[] = [];
  const transport: Transport = { async start() {}, async close() {}, async send(message, options) {
    if (!("method" in message) || !("id" in message)) return;
    methods.push(message.method);
    const params = message.params as Record<string, any>;
    const meta = params?._meta;
    expect(meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(meta?.["io.modelcontextprotocol/clientInfo"]).toMatchObject({ name: "cadence", version: "1" });
    let result: object;
    if (message.method === "server/discover") result = { resultType: "complete", supportedVersions: ["2026-07-28"],
      capabilities: { tools: {}, extensions: { [extension]: {} } } };
    else {
      expect(meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.[extension]).toEqual({});
      if (message.method === "tools/call") result = { resultType: "task", ...task, pollIntervalMs: 100 };
      else {
        expect(message.method).toBe("tasks/get");
        expect(options?.headers?.["Mcp-Name"]).toBe(task.taskId);
        polls.push(Date.now());
        const { pollIntervalMs: _initial, ...snapshot } = task;
        result = { resultType: "complete", ...snapshot,
          ...(polls.length === 1 ? { pollIntervalMs: 400 } : polls.length === 2 ? { pollIntervalMs: 50 } : {}),
          ...(polls.length === 4 ? { status: "completed", result: done } : {}),
        };
      }
    }
    queueMicrotask(() => transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result } as JSONRPCMessage));
  } };
  const clientInfo = { name: "cadence", version: "1" };
  const client = new Client(clientInfo, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(transport);
  const attachment = await attachTaskSession({ client, transport, clientInfo, clientCapabilities: {},
    serverName: "cadence", definition: { command: "in-memory-fixture" } });
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const pending = callToolViaTaskSession(attachment!.session, { name: "work", args: {} });
    await vi.advanceTimersByTimeAsync(99); expect(polls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(polls).toEqual([100]);
    await vi.advanceTimersByTimeAsync(399); expect(polls).toEqual([100]);
    await vi.advanceTimersByTimeAsync(1); expect(polls).toEqual([100, 500]);
    await vi.advanceTimersByTimeAsync(49); expect(polls).toEqual([100, 500]);
    await vi.advanceTimersByTimeAsync(1); expect(polls).toEqual([100, 500, 550]);
    await vi.advanceTimersByTimeAsync(999); expect(polls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); expect(polls).toEqual([100, 500, 550, 1550]);
    await expect(pending).resolves.toMatchObject({ content: [{ text: "finished" }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls).toHaveLength(4);
    expect(methods.filter(method => method === "tools/call")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    attachment!.channel.rejectAll("Test complete"); await attachment!.session.close(); await client.close(); vi.useRealTimers();
  }
});
