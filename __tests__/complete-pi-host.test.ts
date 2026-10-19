import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hostConfig, skillText, skillUri } from "./fixtures/pi-host-config.ts";

it("Pi 1.3.0 with the official faux model executes MCP tools, Tasks, approved Skills, and an idle Events wake-up", async () => {
  const root = await mkdtemp(join(tmpdir(), "complete-pi-host-"));
  const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_MCP_CONFIG_MODE: process.env.PI_MCP_CONFIG_MODE };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_MCP_CONFIG_MODE = "exclusive";
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "mcp-adapter.json"), JSON.stringify(hostConfig));
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const packagePath = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
    expect(JSON.parse(await readFile(packagePath, "utf8")).version).toBe("1.3.0");
    const faux = fauxProvider({ provider: "complete-host-proof" });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "model-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      disabledBuiltinExtensions: ["mcp"],
      additionalExtensionPaths: [process.env.PI_MCP_COMPLETE_PACKED_ENTRY ?? fileURLToPath(new URL("../complete.ts", import.meta.url))],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({
      cwd: root, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), noTools: "builtin",
    }));
    const confirmations: Array<{ title: string; message: string }> = [];
    let approveTools = true;
    const extensionErrors: unknown[] = [];
    initTheme("dark", false);
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        confirm: async (title: string, message: string) => {
          confirmations.push({ title, message });
          return title === "Approve tool use while acting on remote skill?" ? approveTools : true;
        },
        select: async (_title: string, choices: string[]) => choices[0],
        input: async () => "fixture",
        notify() {},
      },
      onError: error => extensionErrors.push(error),
    });
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["mcp", "mcp_skills", "mcp_events", "mcp_protocol"]));
    expect(session.getActiveToolNames()).not.toContain("mcp_event_delivery");
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args));
    faux.setResponses([
      tool("mcp", { server: "complete", tool: "echo", args: {} }),
      tool("mcp", { server: "complete", tool: "task", args: {} }),
      tool("mcp_skills", { action: "list", server: "complete" }),
      tool("mcp_skills", { action: "load", server: "complete", uri: skillUri }),
      tool("mcp_events", { action: "subscribe", server: "complete", name: "tick", arguments: {} }),
      tool("mcp", { server: "complete", tool: "arm_idle_event", args: {} }),
      fauxAssistantMessage("Initial workflow complete; waiting for the subscribed event."),
      context => {
        expect(JSON.stringify(context.messages)).toContain("idle-pi-host-event");
        return fauxAssistantMessage("The idle MCP event woke this second Pi turn.");
      },
    ]);
    const hostEvents: string[] = [];
    session.subscribe(event => hostEvents.push(event.type));
    await session.prompt("Run the configured fixture workflow, load the approved skill, and subscribe to tick events.");
    expect(session.isStreaming).toBe(false);
    expect(faux.state.callCount).toBe(7);
    const resultMessages = session.messages.filter(message => message.role === "toolResult");
    expect(resultMessages).toHaveLength(6);
    expect(resultMessages.filter(message => message.isError)).toEqual([]);
    const resultText = JSON.stringify(resultMessages);
    expect(resultText).toContain("fixture echo");
    expect(resultText).toContain("task done");
    await access(join(agentDir, "mcp-task-recovery", "recovery.sqlite"));
    expect(resultText).toContain(skillUri);
    const loaded = resultMessages.find(message => message.toolName === "mcp_skills" && message.content.some(block => block.type === "text" && block.text.includes("untrusted MCP-origin skill")));
    const loadedText = loaded?.content.find(block => block.type === "text");
    expect(loadedText?.type === "text" && JSON.parse(loadedText.text)).toMatchObject({ uri: skillUri, content: skillText });
    expect(confirmations.some(dialog => dialog.title === "Load remote MCP skill?" && dialog.message.includes(skillUri))).toBe(true);
    await expect.poll(() => session!.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "The idle MCP event woke this second Pi turn.")), { timeout: 8000 }).toBe(true);
    await expect.poll(() => session!.isStreaming).toBe(false);
    expect(faux.state.callCount).toBe(8);
    await expect.poll(() => session!.sessionManager.getEntries().some(entry =>
      entry.type === "custom" && entry.customType === "mcp-events-consumed")).toBe(true);
    expect(hostEvents.filter(type => type === "agent_start")).toHaveLength(2);
    expect(hostEvents.filter(type => type === "agent_end")).toHaveLength(2);
    // isStreaming becomes false before asynchronous settlement handlers finish.
    // Wait for the actual boundary before replacing the model's response queue.
    await expect.poll(() => hostEvents.filter(type => type === "agent_settled").length).toBe(2);

    // The public core tool must retain the adapter's official task execution path.
    faux.setResponses([
      tool("mcp_protocol", { server: "complete", action: "tools/call", params: { name: "task", arguments: {} } }),
      fauxAssistantMessage("Approved core task settled."),
    ]);
    await session.prompt("Call the remote task through the core protocol tool with my approval.");
    const coreTaskResult = session.messages.filter(message => message.role === "toolResult").at(-1);
    expect(coreTaskResult).toMatchObject({ toolName: "mcp_protocol", isError: false, content: [{ type: "text", text: "task done" }] });

    // Decline the real host tool_call hook, including both core call aliases and reads.
    approveTools = false;
    const deniedOffset = session.messages.length;
    const confirmationOffset = confirmations.length;
    faux.setResponses([
      tool("mcp", { server: "complete", tool: "echo", args: { marker: "denied-wire" } }),
      tool("mcp", { server: "complete", tool: "task", args: { marker: "denied-wire" } }),
      tool("mcp_protocol", { server: "complete", action: "tools/call", params: { name: "task", arguments: { marker: "denied-wire" } } }),
      tool("mcp_protocol", { server: "complete", action: "tool/call", params: { name: "echo", arguments: { marker: "denied-wire" } } }),
      tool("mcp_protocol", { server: "complete", action: "resources/read", params: { uri: "fixture://denied-wire" } }),
      fauxAssistantMessage("The operator declined these calls."),
    ]);
    await session.prompt("Attempt these calls while I decline each remote-skill tool approval.");
    const deniedResults = session.messages.slice(deniedOffset).filter(message => message.role === "toolResult");
    expect(deniedResults).toHaveLength(5);
    expect(deniedResults.every(message => message.isError)).toBe(true);
    for (const result of deniedResults)
      expect(JSON.stringify(result.content)).toContain("Remote skills do not authorize local execution or cross-origin tool calls");
    expect(confirmations.slice(confirmationOffset).filter(dialog => dialog.title === "Approve tool use while acting on remote skill?")).toHaveLength(5);

    // Inspect through another approved host tool call, never a direct production bypass.
    approveTools = true;
    faux.setResponses([
      tool("mcp", { server: "complete", tool: "inspect", args: {} }),
      fauxAssistantMessage("Wire audit complete."),
    ]);
    await session.prompt("Inspect the server wire log to verify the declined calls were never sent.");
    const inspection = session.messages.filter(message => message.role === "toolResult").at(-1);
    expect(inspection).toMatchObject({ toolName: "mcp", isError: false });
    const inspectionText = inspection?.content.find(block => block.type === "text");
    if (inspectionText?.type !== "text") throw new Error("Missing wire inspection result");
    const wire = JSON.parse(inspectionText.text);
    expect(JSON.stringify(wire.log)).not.toContain("denied-wire");
    expect(wire.taskCount).toBe(2);
    expect(wire.log.some((row: { method: string }) => row.method === "tasks/get")).toBe(true);
    expect(extensionErrors).toEqual([]);
    expect(faux.getPendingResponseCount()).toBe(0);
  } finally {
    try {
      if (session) {
        await session.abort();
        try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
        finally { session.dispose(); }
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30000);
