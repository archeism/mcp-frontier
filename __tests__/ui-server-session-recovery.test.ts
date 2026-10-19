import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { startUiServer, type UiServerHandle, type UiServerOptions } from "../ui-server.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileTaskRecoveryStore, TaskRecoveryBinding } from "../task-recovery-store.ts";
import type { ConsentManager } from "../consent-manager.ts";
import type { UiResourceContent, McpConfig } from "../types.ts";

function httpError(status: number, message: string): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, message, { status });
}

// Same HTTP helper as __tests__/ui-server.test.ts.
async function request(
  url: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? "GET",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function createMockConsentManager(): ConsentManager {
  return {
    requiresPrompt: vi.fn().mockReturnValue(false),
    shouldCacheConsent: vi.fn().mockReturnValue(true),
    ensureApproved: vi.fn(),
    registerDecision: vi.fn(),
  } as unknown as ConsentManager;
}

function createMockResource(): UiResourceContent {
  return {
    uri: "ui://test/widget",
    html: "<h1>Test App</h1>",
    mimeType: "text/html",
    meta: { permissions: [] },
  };
}

describe("UiServer /proxy/tools/call session recovery", () => {
  let handle: UiServerHandle | null = null;

  afterEach(() => {
    if (handle) {
      handle.close("test-cleanup");
      handle = null;
    }
  });

  it("public HTTP app proxy resumes the original task after polling 404 and owns one stable intent per app request", async () => {
    const root = await mkdtemp(join(tmpdir(), "ui-task-recovery-"));
    const store = new FileTaskRecoveryStore({ sessionId: "ui-pi-owner", sessionFile: join(root, "session.jsonl") });
    const manager = new McpServerManager(process.cwd());
    manager.setTaskRecovery(new TaskRecoveryBinding(store));
    let sessions = 0, invocations = 0, expired = false;
    const wire: Array<{ method: string; session?: string; params: any }> = [];
    const task = { status: "working", createdAt: "2026-10-17T00:00:00Z", lastUpdatedAt: "2026-10-17T00:00:00Z", ttl: 60000, pollInterval: 10 };
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "DELETE") { res.writeHead(200).end(); return; }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      let raw = ""; for await (const chunk of req) raw += chunk;
      const frame = JSON.parse(raw), session = req.headers["mcp-session-id"] as string | undefined;
      wire.push({ method: frame.method, session, params: frame.params });
      const reply = (result: object, headers = {}) => res.writeHead(200, { "content-type": "application/json", ...headers })
        .end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
      if (frame.method === "initialize") {
        reply({ protocolVersion: "2025-11-25", serverInfo: { name: "ui-recovery", version: "1" },
          capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } } }, { "mcp-session-id": `s${++sessions}` }); return;
      }
      if (frame.id === undefined) { res.writeHead(202).end(); return; }
      if (session !== `s${sessions}`) { res.writeHead(404).end("Session not found"); return; }
      switch (frame.method) {
        case "tools/list": reply({ tools: [{ name: "work", inputSchema: { type: "object" }, execution: { taskSupport: "optional" },
          _meta: { ui: { visibility: ["app"] } } }] }); return;
        case "tools/call": invocations++; reply({ task: { ...task, taskId: `ui-task-${invocations}` } }); return;
        case "tasks/get":
          if (!expired) { expired = true; res.writeHead(404).end("Session expired while polling"); return; }
          reply({ ...task, taskId: frame.params.taskId, status: "completed" }); return;
        case "tasks/result": reply({ content: [{ type: "text", text: "original app task recovered" }] }); return;
        default: res.writeHead(500).end(`Unexpected ${frame.method}`);
      }
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const config: McpConfig = { mcpServers: { "test-server": { url: `http://127.0.0.1:${address.port}/mcp`, auth: false, protocolVersion: "legacy", tasks: true } } };
    const consent = createMockConsentManager();
    try {
      await manager.connect("test-server", config.mcpServers["test-server"]!);
      handle = await startUiServer({ serverName: "test-server", toolName: "work", toolArgs: {}, resource: createMockResource(), manager, config, consentManager: consent });
      const post = (token: string) => request(`http://localhost:${handle!.port}/proxy/tools/call`, { method: "POST",
        body: { token, params: { name: "work", arguments: {}, _meta: { "pi-mcp-adapter/toolCallId": "client-forged-id" } } } });
      expect((await post("wrong-token")).status).toBe(403);
      expect(invocations).toBe(0);
      const first = await post(handle.sessionToken);
      expect(first).toMatchObject({ status: 200, body: { ok: true, result: { content: [{ text: "original app task recovered" }] } } });
      expect(invocations).toBe(1);
      expect(sessions).toBe(2);
      const original = wire.find(row => row.method === "tools/call")!;
      const intent = original.params._meta?.["pi-mcp-adapter/toolCallId"];
      expect(intent).toMatch(/^[a-f0-9-]{36}$/);
      expect(intent).not.toBe("client-forged-id");
      expect(await store.read(intent)).toMatchObject({ phase: "completed", reference: { taskId: "ui-task-1" } });
      expect(wire.filter(row => row.method === "tasks/get").map(row => ({ session: row.session, taskId: row.params.taskId })))
        .toEqual([{ session: "s1", taskId: "ui-task-1" }, { session: "s2", taskId: "ui-task-1" }]);
      expect((await post(handle.sessionToken)).status).toBe(200);
      expect(invocations).toBe(2);
      const secondIntent = wire.filter(row => row.method === "tools/call")[1]!.params._meta?.["pi-mcp-adapter/toolCallId"];
      expect(secondIntent).toMatch(/^[a-f0-9-]{36}$/);
      expect(secondIntent).not.toBe(intent);
      expect(secondIntent).not.toBe("client-forged-id");
      expect(consent.ensureApproved).toHaveBeenCalledTimes(2);
      config.mcpServers["test-server"]!.approveTools = true;
      const denied = await post(handle.sessionToken);
      expect(denied.body).toMatchObject({ ok: true, result: { details: { error: "approval_required" } } });
      expect(invocations).toBe(2);
    } finally {
      handle?.close("test-cleanup"); handle = null;
      await manager.closeAll(); store.close(); upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

  it("recovers task-session tool calls transparently when config is supplied", async () => {

    const staleTaskCall = vi.fn().mockRejectedValueOnce(httpError(404, "Session not found"));
    const stale = {
      status: "connected",
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn() },
      taskSession: { callTool: staleTaskCall },
      tools: [{ name: "some_tool" }],
    } as unknown as ServerConnection;
    const result = { content: [{ type: "text", text: "tool result" }] };
    const freshTaskCall = vi.fn().mockResolvedValue({
      kind: "immediate",
      cancel: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      settle: vi.fn().mockResolvedValue({ outcome: { status: "completed", result } }),
    });
    const fresh = {
      status: "connected",
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn() },
      taskSession: { callTool: freshTaskCall },
      tools: [{ name: "some_tool" }],
    } as unknown as ServerConnection;

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => ({ timeout: 4321 })),
    } as unknown as McpServerManager;

    const config: McpConfig = { mcpServers: { "test-server": { url: "https://api.example.com/mcp" } } };

    const options: UiServerOptions = {
      serverName: "test-server",
      toolName: "test_tool",
      toolArgs: {},
      resource: createMockResource(),
      manager,
      config,
      consentManager: createMockConsentManager(),
    };

    handle = await startUiServer(options);

    const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
      method: "POST",
      body: { token: handle.sessionToken, params: { name: "some_tool", arguments: '{"query":"value"}' } },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { content: [{ type: "text", text: "tool result" }] } });
    expect(staleTaskCall).toHaveBeenCalledWith("some_tool", { query: "value" }, { requestTimeoutMs: 4321 });
    expect(freshTaskCall).toHaveBeenCalledWith("some_tool", { query: "value" }, { requestTimeoutMs: 4321 });
    expect((stale.client.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((fresh.client.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(manager.reconnect).toHaveBeenCalledWith("test-server", config.mcpServers["test-server"], stale);
  });

  it("returns auth guidance when recovery reconnect needs auth and no callback can refresh it", async () => {


    const stale = {
      status: "connected",
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValueOnce(httpError(404, "Session not found")) },
      tools: [{ name: "some_tool" }],
    } as unknown as ServerConnection;
    const needsAuth = {
      status: "needs-auth",
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn() },
      tools: [{ name: "some_tool" }],
    } as unknown as ServerConnection;

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => needsAuth),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    } as unknown as McpServerManager;

    handle = await startUiServer({
      serverName: "test-server",
      toolName: "test_tool",
      toolArgs: {},
      resource: createMockResource(),
      manager,
      config: { mcpServers: { "test-server": { url: "https://api.example.com/mcp" } } },
      consentManager: createMockConsentManager(),
    });

    const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
      method: "POST",
      body: { token: handle.sessionToken, params: { name: "some_tool", arguments: {} } },
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      error: expect.stringContaining('mcp({ action: "auth-start", server: "test-server" })'),
    });
  });

  it("uses the supplied auth callback when recovery reconnect returns needs-auth", async () => {


    const stale = {
      status: "connected",
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValueOnce(httpError(404, "Session not found")) },
      tools: [{ name: "some_tool" }],
    } as unknown as ServerConnection;
    const needsAuth = {
      status: "needs-auth",
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn() },
      tools: [{ name: "some_tool" }],
    } as unknown as ServerConnection;
    const fresh = {
      status: "connected",
      transport: { sessionId: "session-3" },
      client: { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "after auth" }] }) },
      tools: [{ name: "some_tool" }],
    } as unknown as ServerConnection;

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => needsAuth),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    } as unknown as McpServerManager;
    const onNeedsAuth = vi.fn(async () => fresh);

    handle = await startUiServer({
      serverName: "test-server",
      toolName: "test_tool",
      toolArgs: {},
      resource: createMockResource(),
      manager,
      config: { mcpServers: { "test-server": { url: "https://api.example.com/mcp" } } },
      onNeedsAuth,
      consentManager: createMockConsentManager(),
    });

    const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
      method: "POST",
      body: { token: handle.sessionToken, params: { name: "some_tool", arguments: {} } },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { content: [{ type: "text", text: "after auth" }] } });
    expect(onNeedsAuth).toHaveBeenCalledWith("test-server");
    expect((fresh.client.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("runs without recovery (unchanged pre-existing behavior) when config is not supplied", async () => {


    const stale = {
      status: "connected",
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValue(httpError(404, "Session not found")) },
      tools: [{ name: "some_tool" }],
    } as unknown as ServerConnection;

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    } as unknown as McpServerManager;

    const options: UiServerOptions = {
      serverName: "test-server",
      toolName: "test_tool",
      toolArgs: {},
      resource: createMockResource(),
      manager,
      // no `config` — recovery must not be attempted
      consentManager: createMockConsentManager(),
    };

    handle = await startUiServer(options);

    const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
      method: "POST",
      body: { token: handle.sessionToken, params: { name: "some_tool", arguments: {} } },
    });

    expect(res.status).toBe(500);
    expect(manager.reconnect).not.toHaveBeenCalled();
    expect((stale.client.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
