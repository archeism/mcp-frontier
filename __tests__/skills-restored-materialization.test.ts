import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Type } from "typebox";
import { createCompleteMcpClient } from "../complete.ts";

it("actual Pi reopened session restores remote origin and denies local materialized-path re-entry before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-restored-path-")), agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const uri = "skill://acme/demo/SKILL.md";
  const source = readFileSync(new URL("./fixtures/skills-server.mjs", import.meta.url), "utf8")
    .replace('resources: []', 'resources: [{uri:"skill://acme/demo/references/guide.txt",name:"guide",mimeType:"application/octet-stream"}]')
    .replace('text: mode === "tamper" ? "tampered bytes" : files.get(request.params.uri)',
      'blob: Buffer.from(mode === "tamper" ? "tampered bytes" : files.get(request.params.uri)).toString("base64")');
  let active: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  let executions = 0, approved = true;
  const prompts: string[] = [];
  try {
    await mkdir(agentDir);
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const faux = fauxProvider({ provider: "restored-skill-path" }); runtime.registerNativeProvider(faux.provider);
    initTheme("dark", false);
    const start = async (sessionManager: InstanceType<typeof SessionManager>) => {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
      const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"], extensionFactories: [pi => {
          createCompleteMcpClient({ config: { mcpServers: { remote: { command: process.execPath, args: ["--input-type=module", "-e", source],
            protocolVersion: "2026-07-28", tasks: false, lifecycle: "eager" } }, settings: { directTools: true, autoAuth: false, sampling: false, elicitation: false } } })(pi);
          pi.registerTool({ name: "local_read", label: "Controlled local reader", description: "Read an explicitly selected local delivery path",
            parameters: Type.Object({ path: Type.String() }), async execute(_id, args) {
              executions++; return { content: [{ type: "text", text: readFileSync(args.path, "utf8") }] };
            } });
        }] });
      await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager,
        modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", noTools: "builtin" });
      active = session;
      await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), notify() {},
        confirm: async (title, message) => { prompts.push(title + "\n" + message); return approved; } } });
      return session;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const before = active!.messages.length;
      faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args)), fauxAssistantMessage("Done.")]);
      await active!.prompt("Run the exact controlled path probe.");
      return active!.messages.slice(before).find(message => message.role === "toolResult")!;
    };
    const manager = SessionManager.create(root, join(root, "sessions"));
    await start(manager);
    expect((await call("mcp_skills", { action: "load", server: "remote", uri })).isError).toBe(false);
    const delivered = await call("remote_read_guide", {});
    const path = JSON.stringify(delivered.content).match(/Binary content saved to ([^"\\]+)/)?.[1];
    expect(path).toBeDefined(); expect(path).toContain("mcp-skill"); expect(existsSync(path!)).toBe(true);
    expect((await call("local_read", { path })).isError).toBe(false); expect(executions).toBe(1);
    const sessionFile = manager.getSessionFile()!; expect(existsSync(sessionFile)).toBe(true);
    await active!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); active!.dispose(); active = undefined;
    approved = false; prompts.length = 0;
    const restored = SessionManager.open(sessionFile);
    expect(restored.getBranch().some(entry => entry.type === "custom" && entry.customType === "mcp-complete-skills-window")).toBe(true);
    await start(restored);
    expect((await call("local_read", { path })).isError).toBe(true); expect(executions).toBe(1);
    expect(prompts.at(-1)).toContain("Remote skill origins: remote");
    expect(prompts.at(-1)).toContain(path!);
    expect(JSON.stringify(active!.messages.at(-2))).toContain("Remote skills do not authorize");
  } finally {
    if (active) { await active.abort(); await active.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); active.dispose(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
