import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RESOURCE_MIME_TYPE } from "../ui-app-bridge-helpers.ts";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
  open: vi.fn(async () => undefined),
  attachTaskSession: vi.fn(async (_options: any) => undefined),
  configureClient: vi.fn((_client: any) => {}),
}));

vi.mock("open", () => ({ default: mocks.open }));

vi.mock("../mcp-tasks.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attachTaskSession: mocks.attachTaskSession,
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation(function (this: any, info: unknown, options: unknown) {
    this.info = info;
    this.options = options;
    this._requestHandlers = new Map();
    this.setRequestHandler = vi.fn((method: string, handler: unknown) => this._requestHandlers.set(method, handler));
    this.notification = vi.fn(async () => undefined);
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async () => undefined);
    this.getServerCapabilities = vi.fn(() => ({ tools: {}, resources: {} }));
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
    mocks.configureClient(this);
  }),
  StreamableHTTPClientTransport: vi.fn(),
  SSEClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: unknown) {
    this.options = options;
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager sampling", () => {
  const originalMcpTestCwd = process.env.MCP_TEST_CWD;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.open.mockClear();
    mocks.attachTaskSession.mockClear();
    mocks.configureClient.mockReset();
  });

  afterEach(() => {
    if (originalMcpTestCwd === undefined) {
      delete process.env.MCP_TEST_CWD;
    } else {
      process.env.MCP_TEST_CWD = originalMcpTestCwd;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync("/tmp/pi-mcp-cwd", { recursive: true, force: true });
    rmSync("/tmp/pi-mcp-home", { recursive: true, force: true });
    rmSync("/tmp/pi-session-cwd", { recursive: true, force: true });
    rmSync("/tmp/server-cwd", { recursive: true, force: true });
  });

  it("advertises sampling and registers the handler before connecting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: {} as any,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toMatchObject({
      capabilities: { sampling: { tools: {} }, tasks: { list: {}, cancel: {}, requests: { sampling: { createMessage: {} } } } },
    });
    expect(client.setRequestHandler).toHaveBeenCalledTimes(7);
    expect(client.options.capabilities.sampling).toEqual({ tools: {} });
    expect(client.options.capabilities.tasks).toEqual({ list: {}, cancel: {}, requests: { sampling: { createMessage: {} } } });
    expect(client.setRequestHandler.mock.calls.map(([method]: [string]) => method)).toEqual([
      "roots/list", "sampling/createMessage", "sampling/createMessage",
      "tasks/list", "tasks/get", "tasks/result", "tasks/cancel",
    ]);
    expect(client.setRequestHandler.mock.invocationCallOrder.at(-1)).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("advertises elicitation capabilities and registers the handler before connecting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setElicitationConfig({
      allowUrl: true,
      ui: {} as any,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toMatchObject({
      capabilities: {
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
    expect(client.setRequestHandler).toHaveBeenCalledTimes(7);
    expect(client.options.capabilities).not.toHaveProperty("sampling");
    expect(client.options.capabilities.tasks).toEqual({ list: {}, cancel: {}, requests: { elicitation: { create: {} } } });
    expect(client.setRequestHandler.mock.calls.map(([method]: [string]) => method)).toEqual([
      "roots/list", "elicitation/create", "elicitation/create",
      "tasks/list", "tasks/get", "tasks/result", "tasks/cancel",
    ]);
    expect(client.setRequestHandler.mock.invocationCallOrder.at(-1)).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("advertises context only with a callback and respects tasks: false", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setSamplingConfig({ autoApprove: true, modelRegistry: {} as any, getCurrentModel: () => undefined, getSignal: () => undefined, getContext: () => [] });
    await manager.connect("demo", { command: "node", tasks: false });
    const client = mocks.clients[0];
    expect(client.options.capabilities.sampling).toEqual({ tools: {}, context: {} });
    expect(client.options.capabilities).not.toHaveProperty("tasks");
    expect(client.setRequestHandler).toHaveBeenCalledTimes(2);
    await manager.closeAll();
  });

  it("shares one receiver for sampling tool results and elicitation", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const model = { provider: "anthropic", id: "test", api: "anthropic-messages", name: "test", input: ["text"] } as any;
    const complete = vi.fn(async () => ({ provider: "anthropic", model: "test", stopReason: "toolUse", content: [{ type: "toolCall", id: "call1", name: "lookup", arguments: { id: "42" } }] }));
    manager.setSamplingConfig({ autoApprove: true, modelRegistry: { getAvailable: () => [model], complete } as any, getCurrentModel: () => model, getSignal: () => undefined });
    manager.setElicitationConfig({ allowUrl: false, ui: { select: vi.fn(async () => "Decline"), input: vi.fn(), notify: vi.fn() } });
    await manager.connect("demo", { command: "node" });
    const handlers = mocks.clients[0]._requestHandlers;
    const sample = await handlers.get("sampling/createMessage")({ method: "sampling/createMessage", params: {
      task: {}, messages: [], maxTokens: 100, tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    } });
    const elicitation = await handlers.get("elicitation/create")({ method: "elicitation/create", params: {
      task: {}, mode: "form", message: "Enter a value", requestedSchema: { type: "object", properties: {} },
    } });
    expect(await handlers.get("tasks/result")({ params: { taskId: sample.task.taskId } })).toEqual({
      role: "assistant", model: "anthropic/test", stopReason: "toolUse",
      content: [{ type: "tool_use", id: "call1", name: "lookup", input: { id: "42" } }],
    });
    expect(await handlers.get("tasks/result")({ params: { taskId: elicitation.task.taskId } })).toEqual({ action: "decline" });
    expect((await handlers.get("tasks/list")({ params: {} })).tasks).toHaveLength(2);
    await manager.closeAll();
  });

  async function beginElicitationTask(client: any) {
    const created = await client._requestHandlers.get("elicitation/create")({
      method: "elicitation/create",
      params: { task: {}, mode: "form", message: "Enter a value", requestedSchema: { type: "object", properties: {} } },
    });
    const result = client._requestHandlers.get("tasks/result")({ params: { taskId: created.task.taskId } });
    void result.catch(() => {});
    return { result, taskId: created.task.taskId };
  }

  it.each(["disconnect", "remote-close", "replacement"])("releases pending receiver tasks on %s", async event => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: false, ui: { select: vi.fn(() => new Promise(() => {})), input: vi.fn(), notify: vi.fn() } });
    const definition = { command: "node" };
    const connection = await manager.connect("demo", definition);
    const client = mocks.clients[0];
    const task = await beginElicitationTask(client);
    if (event === "disconnect") await manager.close("demo");
    else if (event === "remote-close") client.onclose();
    else {
      const fresh = await manager.reconnect("demo", definition, connection);
      expect(fresh.client).not.toBe(client);
      expect(mocks.clients[1]._requestHandlers.has("tasks/get")).toBe(true);
      // A stale close must not dispose the replacement's receiver.
      client.onclose();
      expect(mocks.clients[1]._requestHandlers.has("tasks/get")).toBe(true);
    }
    await expect(task.result).rejects.toThrow("receiver binding closed");
    expect(client._requestHandlers.has("tasks/result")).toBe(false);
    await manager.closeAll();
  });

  it("releases receiver tasks when metadata discovery fails", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: false, ui: { select: vi.fn(() => new Promise(() => {})), input: vi.fn(), notify: vi.fn() } });
    let pending: Promise<unknown> | undefined;
    mocks.configureClient.mockImplementationOnce(client => {
      client.listTools.mockImplementationOnce(async () => {
        pending = (await beginElicitationTask(client)).result;
        throw new Error("metadata failed");
      });
    });
    await expect(manager.connect("demo", { command: "node" })).rejects.toThrow("metadata failed");
    await expect(pending).rejects.toThrow("receiver binding closed");
    expect(mocks.clients[0]._requestHandlers.has("tasks/result")).toBe(false);
  });

  it("advertises form-only elicitation when URL navigation is unavailable", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: false, ui: {} as any });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(mocks.clients[0].options).toMatchObject({
      capabilities: { elicitation: { form: {} } },
    });
  });

  it("notifies only when a known URL elicitation completes", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const ui = {
      select: vi.fn().mockResolvedValue("Open"),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: true, ui: ui as any });
    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    const requestHandler = client.setRequestHandler.mock.calls.find(([method]: [string]) => method === "elicitation/create")[1];
    await requestHandler({
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Connect",
        elicitationId: "known-id",
        url: "https://example.com/connect",
      },
    });
    const completionHandler = client.setNotificationHandler.mock.calls[0][1];
    completionHandler({ params: { elicitationId: "unknown-id" } });
    completionHandler({ params: { elicitationId: "known-id" } });
    completionHandler({ params: { elicitationId: "known-id" } });

    expect(ui.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
    expect(ui.notify).toHaveBeenCalledWith(
      "MCP browser interaction for demo completed. You can retry the tool now.",
      "info",
    );
    expect(ui.notify).toHaveBeenCalledTimes(2);
  });

  it("handles every URL in a URL-required error", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
    const { McpServerManager } = await import("../server-manager.ts");
    const ui = {
      select: vi.fn().mockResolvedValue("Open"),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: true, ui: ui as any });
    const result = await manager.handleUrlElicitationRequired("demo", new UrlElicitationRequiredError([
      { mode: "url", message: "First", elicitationId: "one", url: "https://example.com/one" },
      { mode: "url", message: "Second", elicitationId: "two", url: "https://example.com/two" },
    ]));

    expect(result).toBe("accept");
    expect(mocks.open).toHaveBeenNthCalledWith(1, "https://example.com/one");
    expect(mocks.open).toHaveBeenNthCalledWith(2, "https://example.com/two");
  });

  it("advertises sampling and elicitation together", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: {} as any,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });
    manager.setElicitationConfig({
      allowUrl: true,
      ui: {} as any,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(mocks.clients[0].options).toMatchObject({
      capabilities: {
        sampling: { tools: {} },
        tasks: { list: {}, cancel: {}, requests: { sampling: { createMessage: {} }, elicitation: { create: {} } } },
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
    expect(mocks.clients[0].setRequestHandler).toHaveBeenCalledTimes(9);
    expect(mocks.clients[0].options.capabilities.sampling).toEqual({ tools: {} });
    expect(mocks.clients[0].options.capabilities.tasks).toEqual({ list: {}, cancel: {}, requests: { sampling: { createMessage: {} }, elicitation: { create: {} } } });
    expect(mocks.clients[0].setRequestHandler.mock.calls.map(([method]: [string]) => method)).toEqual([
      "roots/list", "sampling/createMessage", "elicitation/create",
      "sampling/createMessage", "elicitation/create",
      "tasks/list", "tasks/get", "tasks/result", "tasks/cancel",
    ]);
  });

  it("does not advertise sampling when no sampling config is set", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options.capabilities).not.toHaveProperty("sampling");
    expect(client.options.listChanged.tools.onChanged).toBeTypeOf("function");
    expect(client.options.listChanged.resources.onChanged).toBeTypeOf("function");
    expect(client.setRequestHandler).toHaveBeenCalledExactlyOnceWith("roots/list", expect.any(Function));
  });

  it("passes the MCP Apps capability through legacy and modern client paths", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("legacy", { command: "node", args: ["server.js"] });
    await manager.connect("auto", {
      command: "node",
      args: ["server.js"],
      protocolVersion: "auto",
    });
    await manager.connect("pinned", {
      command: "node",
      args: ["server.js"],
      protocolVersion: "2026-07-28",
    });

    const expectedCapabilities = {
      roots: { listChanged: true },
      extensions: {
        "io.modelcontextprotocol/skills": {},
        "io.modelcontextprotocol/ui": {
          mimeTypes: [RESOURCE_MIME_TYPE],
        },
      },
    };
    expect(mocks.clients.map(client => client.options.capabilities)).toEqual([
      expectedCapabilities,
      expectedCapabilities,
      expectedCapabilities,
    ]);
    expect(mocks.clients.map(client => client.options.versionNegotiation)).toEqual([
      undefined,
      { mode: "auto" },
      { mode: { pin: "2026-07-28" } },
    ]);
  });

  it("does not advertise MCP Apps to a server with openUi: false", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: {} as any,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });

    await manager.connect("headless", { command: "node", args: ["server.js"], openUi: false });
    await manager.connect("windowed", { command: "node", args: ["server.js"] });

    const sessionCapabilities = mocks.attachTaskSession.mock.calls.map(([options]) => options.clientCapabilities);
    const headless = { roots: { listChanged: true }, extensions: { "io.modelcontextprotocol/skills": {} }, sampling: { tools: {} }, tasks: { list: {}, cancel: {}, requests: { sampling: { createMessage: {} } } } };
    expect(mocks.clients[0].options.capabilities).toEqual(headless);
    expect(sessionCapabilities[0]).toEqual(headless);
    const windowed = {
      roots: { listChanged: true },
      extensions: { "io.modelcontextprotocol/skills": {}, "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } },
      sampling: { tools: {} },
      tasks: { list: {}, cancel: {}, requests: { sampling: { createMessage: {} } } },
    };
    expect(mocks.clients[1].options.capabilities).toEqual(windowed);
    expect(sessionCapabilities[1]).toEqual(windowed);
  });

  it("refreshes cached lists and ignores notifications from replaced clients", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const metadataChanged = vi.fn();
    manager.setMetadataListChangedListener(metadataChanged);

    await manager.connect("demo", { command: "node", args: ["server.js"] });
    const oldClient = mocks.clients[0];
    await manager.close("demo");
    await manager.connect("demo", { command: "node", args: ["server.js"] });
    const freshClient = mocks.clients[1];
    const freshTools = [{ name: "fresh_tool", description: "Fresh tool" }];
    const freshResources = [{ uri: "file://fresh", name: "Fresh resource" }];

    oldClient.options.listChanged.tools.onChanged(null, [{ name: "stale_tool" }]);
    oldClient.options.listChanged.resources.onChanged(null, [{ uri: "file://stale", name: "Stale resource" }]);
    expect(manager.getConnection("demo")?.tools).toEqual([]);
    expect(manager.getConnection("demo")?.resources).toEqual([]);
    expect(metadataChanged).not.toHaveBeenCalled();

    freshClient.options.listChanged.tools.onChanged(null, freshTools);
    freshClient.options.listChanged.resources.onChanged(null, freshResources);
    expect(manager.getConnection("demo")?.tools).toEqual(freshTools);
    expect(manager.getConnection("demo")?.resources).toEqual(freshResources);
    expect(metadataChanged).toHaveBeenCalledWith("demo", "tools-list-changed");
    expect(metadataChanged).toHaveBeenCalledWith("demo", "resources-list-changed");
  });

  it("preserves tools list cache hints across list-changed refreshes", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    connection.toolListHints = { ttlMs: 0, cacheScope: "private" };

    client.options.listChanged.tools.onChanged(null, [{ name: "fresh_tool" }]);

    expect(connection.tools).toEqual([{ name: "fresh_tool" }]);
    expect(connection.toolListHints).toEqual({ ttlMs: 0, cacheScope: "private" });
  });

  it("forces an authoritative tool refresh and publishes catalog changes", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const metadataChanged = vi.fn();
    manager.setMetadataListChangedListener(metadataChanged);

    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const freshTools = [{ name: "fresh_tool", description: "Fresh tool" }];
    client.listTools.mockResolvedValueOnce({ tools: freshTools });

    await expect(manager.refreshTools("demo", connection)).resolves.toBe("updated");

    expect(client.listTools).toHaveBeenLastCalledWith(undefined, expect.objectContaining({
      cacheMode: "refresh",
      timeout: 5_000,
    }));
    expect(connection.tools).toEqual(freshTools);
    expect(metadataChanged).toHaveBeenCalledWith("demo", "keep-alive-refresh");

    metadataChanged.mockClear();
    client.listTools.mockResolvedValueOnce({ tools: freshTools });
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");
    expect(metadataChanged).not.toHaveBeenCalled();
  });

  it("keeps every page of an authoritative tool refresh", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const initialListCalls = client.listTools.mock.calls.length;
    client.listTools
      .mockResolvedValueOnce({
        tools: [{ name: "first_page_tool" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({ tools: [{ name: "second_page_tool" }] });

    await expect(manager.refreshTools("demo", connection)).resolves.toBe("updated");

    expect(connection.tools.map(tool => tool.name)).toEqual([
      "first_page_tool",
      "second_page_tool",
    ]);
    expect(client.listTools).toHaveBeenNthCalledWith(
      initialListCalls + 1,
      undefined,
      expect.objectContaining({ cacheMode: "refresh", timeout: 5_000 }),
    );
    expect(client.listTools).toHaveBeenLastCalledWith(
      { cursor: "page-2" },
      expect.objectContaining({ cacheMode: "refresh", timeout: 5_000 }),
    );
  });

  it("retries publication when a refreshed catalog listener fails", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const publicationError = new Error("cache unavailable");
    const metadataChanged = vi.fn().mockImplementationOnce(() => { throw publicationError; });
    manager.setMetadataListChangedListener(metadataChanged);

    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const freshTools = [{ name: "fresh_tool", description: "Fresh tool" }];
    mocks.clients[0].listTools.mockResolvedValueOnce({ tools: freshTools });

    await expect(manager.refreshTools("demo", connection)).rejects.toBe(publicationError);
    expect(connection.tools).toEqual([]);

    mocks.clients[0].listTools.mockResolvedValueOnce({ tools: freshTools });
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("updated");
    expect(connection.tools).toEqual(freshTools);
  });

  it("queues a failed session-reconnect publication for the next refresh", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const publicationError = new Error("cache unavailable");
    const metadataChanged = vi.fn()
      .mockImplementationOnce(() => { throw publicationError; })
      .mockImplementation(() => undefined);
    manager.setMetadataListChangedListener(metadataChanged);
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(manager.publishMetadataChanged("demo", connection, "session-reconnect")).toBe(false);
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");

    expect(metadataChanged).toHaveBeenNthCalledWith(1, "demo", "session-reconnect");
    expect(metadataChanged).toHaveBeenNthCalledWith(2, "demo", "session-reconnect");
  });

  it("pings keep-alive connections whose negotiated server has no tools capability", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const initialListCalls = client.listTools.mock.calls.length;
    client.getServerCapabilities.mockReturnValue({ resources: {} });
    client.ping = vi.fn(async () => ({}));

    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");

    expect(client.ping).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5_000 }));
    expect(client.listTools).toHaveBeenCalledTimes(initialListCalls);
  });

  it("marks only tools/list keep-alive timeout errors as refresh timeouts", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const { SdkError, SdkErrorCode } = await import("@modelcontextprotocol/client");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const timeout = new SdkError(SdkErrorCode.RequestTimeout, "Request timed out");
    client.listTools.mockRejectedValueOnce(timeout);

    await expect(manager.refreshTools("demo", connection)).resolves.toBe("refresh-timeout");

    client.getServerCapabilities.mockReturnValue({ resources: {} });
    client.ping = vi.fn(async () => { throw timeout; });
    await expect(manager.refreshTools("demo", connection)).rejects.toBe(timeout);
  });

  it.each([
    {
      kind: "tools" as const,
      reason: "tools-list-changed",
      next: [{ name: "fresh_tool", description: "Fresh tool" }],
    },
    {
      kind: "prompts" as const,
      reason: "prompts-list-changed",
      next: [{ name: "fresh_prompt", description: "Fresh prompt" }],
    },
    {
      kind: "resources" as const,
      reason: "resources-list-changed",
      next: [{ uri: "file://fresh", name: "Fresh resource" }],
    },
  ])("retries a failed $kind list-changed publication on the next unchanged refresh", async ({ kind, reason, next }) => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const metadataChanged = vi.fn()
      .mockImplementationOnce(() => { throw new Error("cache unavailable"); })
      .mockImplementation(() => undefined);
    manager.setMetadataListChangedListener(metadataChanged);

    client.options.listChanged[kind].onChanged(null, next);
    expect(connection[kind]).toEqual(next);

    client.listTools.mockResolvedValueOnce({ tools: connection.tools });
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");

    expect(metadataChanged).toHaveBeenCalledTimes(2);
    expect(metadataChanged).toHaveBeenNthCalledWith(2, "demo", reason);
  });

  it("retries queued metadata publication after a no-tools ping", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    client.getServerCapabilities.mockReturnValue({ resources: {} });
    client.ping = vi.fn(async () => ({}));
    const metadataChanged = vi.fn()
      .mockImplementationOnce(() => { throw new Error("cache unavailable"); })
      .mockImplementation(() => undefined);
    manager.setMetadataListChangedListener(metadataChanged);

    expect(manager.publishMetadataChanged("demo", connection, "session-reconnect")).toBe(false);
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");

    expect(metadataChanged).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a newer list-changed catalog with an older refresh response", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    let resolveRefresh!: (value: { tools: Array<{ name: string }> }) => void;
    client.listTools.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));

    const refresh = manager.refreshTools("demo", connection);
    await Promise.resolve();
    const notificationTools = [{ name: "notification_tool" }];
    client.options.listChanged.tools.onChanged(null, notificationTools);
    resolveRefresh({ tools: [{ name: "older_refresh_tool" }] });

    await expect(refresh).resolves.toBe("superseded");
    expect(connection.tools).toEqual(notificationTools);
  });

  it("logs list-change callback errors without replacing cached metadata", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const error = new Error("refresh failed");

    client.options.listChanged.tools.onChanged(error, null);
    client.options.listChanged.resources.onChanged(error, null);

    expect(manager.getConnection("demo")?.tools).toEqual([]);
    expect(manager.getConnection("demo")?.resources).toEqual([]);
  });

  it("expands environment variables and tilde in stdio cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_CWD = "/tmp/pi-mcp-cwd";
    process.env.HOME = "/tmp/pi-mcp-home";
    mkdirSync("/tmp/pi-mcp-cwd/nested", { recursive: true });
    mkdirSync("/tmp/pi-mcp-home/nested", { recursive: true });

    const envManager = new McpServerManager();
    await envManager.connect("env-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "${MCP_TEST_CWD}/nested",
    });

    const homeManager = new McpServerManager();
    await homeManager.connect("home-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "~/nested",
    });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-mcp-cwd/nested" });
    expect(mocks.transports[1].options).toMatchObject({ cwd: "/tmp/pi-mcp-home/nested" });
  });

  it("uses the session cwd for stdio servers without an explicit cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mkdirSync("/tmp/pi-session-cwd", { recursive: true });
    const manager = new McpServerManager("/tmp/pi-session-cwd");

    await manager.connect("session-cwd", { command: "node", args: ["server.js"] });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-session-cwd" });
  });

  it("prefers an explicit stdio cwd over the session cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mkdirSync("/tmp/pi-session-cwd", { recursive: true });
    mkdirSync("/tmp/server-cwd", { recursive: true });
    const manager = new McpServerManager("/tmp/pi-session-cwd");

    await manager.connect("explicit-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "/tmp/server-cwd",
    });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/server-cwd" });
  });

  it("applies the global timeout to connect and discovery requests", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 2500 });
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 2500 });
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 2500 });
  });

  it("prefers the per-server timeout for connect and discovery requests", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"], requestTimeoutMs: 5000 });

    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 5000 });
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 5000 });
  });

  it("builds request options from global and per-server timeouts", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"], requestTimeoutMs: 5000 });
    await manager.connect("sdk-default", { command: "node", args: ["server.js"], requestTimeoutMs: 0 });

    const signal = new AbortController().signal;
    expect(manager.getRequestOptions("demo", signal)).toEqual({ signal, timeout: 5000 });
    expect(manager.getRequestOptions("missing", signal)).toEqual({ signal, timeout: 2500 });
    expect(manager.getRequestOptions("missing")).toEqual({ timeout: 2500 });
    expect(manager.getRequestOptions("sdk-default")).toBeUndefined();

    manager.setDefaultRequestTimeoutMs(0);
    expect(manager.getRequestOptions("missing")).toBeUndefined();
  });
});
