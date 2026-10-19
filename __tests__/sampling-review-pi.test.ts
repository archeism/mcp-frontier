import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createCompleteMcpClient } from "../complete.ts";
import { startTaskTrustServer } from "./fixtures/task-trust-server.mjs";

it.each(["accept", "cancel-editor", "abort-response"] as const)("actual Pi sampling edit %s preserves final approval and fails closed", async mode => {
  const root = await mkdtemp(join(tmpdir(), "sampling-review-pi-")), agentDir = join(root, "agent"); await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const server = await startTaskTrustServer();
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const faux = fauxProvider({ provider: "sampling-review-pi" }); runtime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" }); settingsManager.setRetryEnabled(false);
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"], extensionFactories: [
        createCompleteMcpClient({ config: { mcpServers: { trust: { url: server.url, auth: false, headers: { Authorization: "Bearer task-trust-fixture" },
          protocolVersion: "2026-07-28", tasks: true, lifecycle: "eager" } }, settings: { sampling: true, samplingAutoApprove: false,
          elicitation: false, approveTools: false, autoAuth: false, directTools: false } } }),
      ] });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
    initTheme("dark", false);
    let edits = 0, providerCalls = 0;
    const approvals: string[] = [], edited = "operator edited prompt " + "full-text ".repeat(100) + "EDITED_TAIL";
    const response = "review response ".repeat(100) + "GENERATED_TAIL";
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), notify() {},
      select: async (_title, choices) => choices.includes("Edit prompt") ? (edits ? "Continue" : "Edit prompt") : "System prompt",
      editor: async (title, original) => { expect(title).toBe("System prompt"); expect(original).toBe(""); edits++;
        return mode === "cancel-editor" ? undefined : edited; },
      confirm: async (title, body) => {
        approvals.push(title);
        if (title === "Approve MCP sampling request") { expect(body).toContain(edited); expect(body).toContain("untrusted server-supplied history"); expect(providerCalls).toBe(0); }
        if (title === "Return MCP sampling response") {
          expect(body).toContain(response); expect(server.inputs).toHaveLength(0);
          if (mode === "abort-response") { queueMicrotask(() => { void session!.abort(); }); return new Promise<boolean>(() => {}); }
        }
        return true;
      },
    } });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp", { server: "trust", tool: "sampling", args: {} })),
      ...(mode === "cancel-editor" ? [] : [async (context: TranscriptContext) => {
        expect(context.messages.find(message => message.role === "system")?.content).toBe(edited); expect(approvals).toContain("Approve MCP sampling request");
        expect(approvals).not.toContain("Return MCP sampling response"); providerCalls++;
        return fauxAssistantMessage(response);
      }]), fauxAssistantMessage("Done.")]);
    await session.prompt("Execute the controlled task sampling probe.");
    expect(edits).toBe(1); expect(providerCalls).toBe(mode === "cancel-editor" ? 0 : 1);
    if (mode === "accept") {
      expect(approvals).toEqual(["Approve MCP sampling request", "Return MCP sampling response"]);
      expect(JSON.stringify(server.inputs)).toContain("GENERATED_TAIL");
    } else {
      expect(server.wire.filter(row => row.direction === "client" && row.frame.method === "tasks/update")).toEqual([]);
      expect(JSON.stringify(server.inputs)).not.toContain("GENERATED_TAIL");
      if (mode === "cancel-editor") expect(approvals).toEqual([]);
    }
  } finally {
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    await server.close(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
