import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each(["proxy", "direct", "script", "script-parallel"] as const)("actual Pi %s resumes durable HTTP tasks after session expiry without repeating tools/call", async mode => {
  const root = await mkdtemp(join(tmpdir(), "pi-task-recovery-")), agentDir = join(root, "agent");
  const scopesFile = join(root, "factory-scopes.jsonl");
  const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_MCP_CONFIG_MODE: process.env.PI_MCP_CONFIG_MODE };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_MCP_CONFIG_MODE = "exclusive";
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  let sessions = 0, invocations = 0, expired = false;
  const calls: Array<{ method: string; session: string | undefined; params: any }> = [];
  const task = { taskId: "pi-durable-1", status: "working", createdAt: "2026-10-17T00:00:00Z",
    lastUpdatedAt: "2026-10-17T00:00:00Z", ttl: 60000, pollInterval: 10 };
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const frame = JSON.parse(body), id = req.headers["mcp-session-id"] as string | undefined;
    calls.push({ method: frame.method, session: id, params: frame.params });
    const reply = (result: object, headers = {}) => res.writeHead(200, { "content-type": "application/json", ...headers })
      .end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    if (frame.method === "initialize") {
      reply({ protocolVersion: "2025-11-25", capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
        serverInfo: { name: "pi-recovery", version: "1" } }, { "mcp-session-id": `pi-session-${++sessions}` }); return;
    }
    if (frame.id === undefined) { res.writeHead(202).end(); return; }
    if (id !== `pi-session-${sessions}`) { res.writeHead(404).end("Unknown session"); return; }
    switch (frame.method) {
      case "tools/list": reply({ tools: [{ name: "work", description: "Durable fixture work", inputSchema: { type: "object" },
        execution: { taskSupport: "optional" } }] }); return;
      case "tools/call": invocations++; reply({ task: { ...task, taskId: `pi-durable-${invocations}` } }); return;
      case "tasks/get":
        if (!expired) { expired = true; res.writeHead(404).end("Session expired while polling"); return; }
        reply({ ...task, taskId: frame.params.taskId, status: "completed" }); return;
      case "tasks/result": reply({ content: [{ type: "text", text: "Recovered original Pi task" }] }); return;
      default: res.writeHead(500).end(`Unexpected ${frame.method}`);
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await mkdir(agentDir, { recursive: true });
    const extensionPath = join(root, "recovery-extension.mjs");
    const config = { mcpServers: { recovery: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
      auth: false, protocolVersion: "legacy", tasks: true, lifecycle: "eager" } },
      settings: { sampling: false, elicitation: false, approveTools: false, directTools: mode === "direct", autoAuth: false, scriptMode: true } };
    // Runtime fixture only: exercise the public option exactly as a host extension does.
    await writeFile(extensionPath, `import { appendFileSync } from "node:fs";
import { createCompleteMcpClient } from ${JSON.stringify(new URL("../complete.ts", import.meta.url).href)};
import { FileTaskRecoveryStore } from ${JSON.stringify(new URL("../task-recovery-store.ts", import.meta.url).href)};
export default createCompleteMcpClient({ config: ${JSON.stringify(config)}, createTaskRecoveryStore(scope) {
  appendFileSync(${JSON.stringify(scopesFile)}, JSON.stringify({ sessionId: scope.sessionId, sessionFile: scope.sessionFile }) + "\\n");
  return new FileTaskRecoveryStore(scope);
} });\n`);
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const faux = fauxProvider({ provider: "pi-task-recovery-test" });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"],
      additionalExtensionPaths: [extensionPath] });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
      resourceLoader: loader, settingsManager, sessionManager, noTools: "builtin" }));
    initTheme("dark", false);
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(),
      confirm: async () => true, select: async (_title: string, choices: string[]) => choices[0], notify() {} } });
    const scriptCode = `emit(await tools.call("recovery_work", {}));${mode === "script-parallel" ? 'emit(await Promise.all([tools.call("recovery_work", {}), tools.call("recovery_work", {})]));' : ""}`;
    const toolName = mode === "proxy" ? "mcp" : mode === "direct" ? "recovery_work" : "mcpScript";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(toolName, mode === "proxy"
        ? { server: "recovery", tool: "work", args: {} }
        : mode === "direct" ? {} : { code: scriptCode }, { id: "outer-recovery-call" })),
      fauxAssistantMessage("Original task recovered."),
    ]);
    await session.prompt("Run the durable work once and recover its result.");
    const result = session.messages.find(message => message.role === "toolResult" && message.toolName === toolName);
    expect(result).toMatchObject({ isError: false });
    expect(JSON.stringify(result)).toContain("Recovered original Pi task");
    expect(invocations).toBe(mode === "script-parallel" ? 3 : 1); expect(sessions).toBe(2);
    const scopes = (await readFile(scopesFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(scopes).toEqual([{ sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile() }]);
    const original = calls.find(call => call.method === "tools/call")!;
    expect(original.params._meta["pi-mcp-adapter/toolCallId"]).toBeTruthy();
    if (mode === "script" || mode === "script-parallel") {
      const identities = calls.filter(call => call.method === "tools/call").map(call => call.params._meta["pi-mcp-adapter/toolCallId"]);
      expect(identities).toEqual(Array.from({ length: mode === "script-parallel" ? 3 : 1 }, (_, i) => JSON.stringify(["mcpScript", "outer-recovery-call", i])));
      expect(new Set(identities).size).toBe(identities.length);
      // Explicit re-entry of the same public outer intent restarts the worker,
      // not the remote actions: the deterministic child sequence must replay
      // the recorded results, including the two parallel children.
      const scriptTool = loader.getExtensions().extensions.flatMap(ext => [...ext.tools.values()])
        .find(tool => tool.definition.name === "mcpScript")!.definition;
      const replay = await scriptTool.execute("outer-recovery-call", { code: scriptCode }, undefined, undefined,
        session.extensionRunner.createContext());
      expect(JSON.stringify(replay)).toContain("Recovered original Pi task");
      expect(invocations).toBe(identities.length);
    }
    expect(calls.filter(call => call.method === "tasks/get").slice(0, 2).map(call => call.session)).toEqual(["pi-session-1", "pi-session-2"]);
    const perTaskGets = calls.filter(call => call.method === "tasks/get" && call.params.taskId === "pi-durable-1");
    expect(perTaskGets.map(call => call.session)).toEqual(["pi-session-1", "pi-session-2"]);
  } finally {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
