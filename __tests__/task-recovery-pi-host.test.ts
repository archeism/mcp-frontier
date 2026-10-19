import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createCompleteMcpClient } from "../complete.ts";
import { FileTaskRecoveryStore } from "../task-recovery-store.ts";
import { hostConfig } from "./fixtures/pi-host-config.ts";

it("actual Pi proxy and core Tasks preserve their tool-call identities in the session recovery store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-task-recovery-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  let store: FileTaskRecoveryStore | undefined;
  try {
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const agentDir = join(root, "agent"); await mkdir(agentDir); process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const faux = fauxProvider({ provider: "task-recovery-host" }); runtime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const sessionManager = SessionManager.inMemory(root);
    const scopes: string[] = [];
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noContextFiles: true, noThemes: true, noPromptTemplates: true, disabledBuiltinExtensions: ["mcp"],
      extensionFactories: [createCompleteMcpClient({ config: hostConfig, createTaskRecoveryStore: scope => {
        scopes.push(scope.sessionId);
        store = new FileTaskRecoveryStore({ ...scope, sessionFile: join(root, "session.jsonl") }); return store;
      } })],
    });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
      resourceLoader: loader, sessionManager, settingsManager, noTools: "builtin" }));
    await session.bindExtensions({ mode: "print" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp", { server: "complete", tool: "task", args: {} }, { id: "proxy-task-id" })),
      fauxAssistantMessage(fauxToolCall("mcp_protocol", { server: "complete", action: "tools/call", params: { name: "task", arguments: {} } }, { id: "core-task-id" })),
      fauxAssistantMessage("Both tasks completed."),
    ]);
    await session.prompt("Execute both configured tasks.");
    expect(session.messages.filter(message => message.role === "toolResult" && message.isError)).toEqual([]);
    expect(scopes).toEqual([sessionManager.getSessionId()]);
    expect(store).toBeDefined();
    expect(await store!.read("proxy-task-id")).toMatchObject({ phase: "completed", name: "task" });
    expect(await store!.read("core-task-id")).toMatchObject({ phase: "completed", name: "task" });
  } finally {
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
