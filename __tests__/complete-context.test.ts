import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import type { McpConfig } from "../types.ts";

const require = createRequire(import.meta.url);
const sdkUrl = (name: string) => pathToFileURL(require.resolve(name).replace(/\.cjs$/, ".mjs")).href;
// A real official SDK server, launched with Node. No fixture or production edits needed.
const serverSource = `
import { Server } from ${JSON.stringify(sdkUrl("@modelcontextprotocol/server"))};
import { StdioServerTransport } from ${JSON.stringify(sdkUrl("@modelcontextprotocol/server/stdio"))};
const server = new Server({ name: "context-consent-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", async () => ({ tools: ["echo", "sample"].map(name => ({ name, inputSchema: { type: "object", properties: {} } })) }));
server.setRequestHandler("tools/call", async request => {
  if (request.params.name === "echo") return { content: [{ type: "text", text: "echo" }] };
  try {
    const result = await server.createMessage({ includeContext: request.params.arguments.scope, maxTokens: 100,
      messages: [{ role: "user", content: { type: "text", text: "sampling-request-only" } }] });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: "text", text: "sampling denied: " + error.message }] }; }
});
await server.connect(new StdioServerTransport());
`;

describe("Skills approval revocation during real stdio reads", () => {
  for (const dynamic of [false, true]) for (const reapprove of [false, true])
    it(`dynamic=${dynamic}, reapprove=${reapprove}: rejects the old read without revoking a replacement approval`, async () => {
      const { McpServerManager } = await import("../server-manager.ts");
      const { createProtocolSession } = await import("../runtime-protocol.ts");
      const { SkillsClient, SKILLS_PROTOCOL } = await import("../mcp-skills.ts");
      const manager = new McpServerManager(process.cwd());
      const owner = new AbortController();
      let release!: () => void;
      let reached!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const receiving = new Promise<void>(resolve => { reached = resolve; });
      const uri = "skill://acme/demo/SKILL.md";
      try {
        const connection = await manager.connect("revocation", { command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/skills-server.mjs", import.meta.url))],
          protocolVersion: "2026-07-28", tasks: false });
        const control = (arguments_: Record<string, unknown>) => connection.client.callTool({ name: "control", arguments: arguments_ });
        if (dynamic) await control({ mode: "dynamic" });
        const session = createProtocolSession(connection, owner.signal, SKILLS_PROTOCOL);
        let pause = false;
        const client = new SkillsClient({ ...session, async request(method, params, signal) {
          const result = await session.request(method, params, signal);
          if (pause && method === "resources/read" && params?.uri === "skill://acme/demo/references/guide.txt") {
            pause = false;
            reached();
            await blocked;
          }
          return result;
        } });
        await client.load(uri, async () => true, undefined, dynamic);
        pause = true;
        const oldRead = client.read(uri, "references/guide.txt", undefined, async () => true);
        const rejected = expect(oldRead).rejects.toThrow("revoked");
        await receiving;
        if (!dynamic) await control({ change: true });
        await client.get(uri);
        if (reapprove) await client.load(uri, async () => true, undefined, dynamic);
        release();
        await rejected;
        if (reapprove) await expect(client.read(uri, "references/guide.txt", undefined, async () => true)).resolves.toMatchObject({ text: expect.any(String) });
        else await expect(client.read(uri, "references/guide.txt", undefined, async () => true)).rejects.toThrow("revoked");
      } finally {
        release(); owner.abort(); await manager.closeAll();
      }
    }, 10000);
});

describe("actual Pi host sampling context consent", () => {
  for (const testCase of [
    { scope: "allServers", consent: true, ui: true },
    { scope: "thisServer", consent: true, ui: true },
    { scope: "allServers", consent: false, ui: true },
    { scope: "thisServer", consent: false, ui: true },
    { scope: "allServers", consent: false, ui: false },
    { scope: "thisServer", consent: true, ui: true, ambiguousNames: true },
  ] as const) {
    const { scope, consent, ui } = testCase;
    const ambiguousNames = "ambiguousNames" in testCase;
    it(`${scope}, consent=${consent}, UI=${ui}, ambiguousNames=${ambiguousNames}: auto-approved sampling still requires independent context consent`, async () => {
    const root = await mkdtemp(join(tmpdir(), "complete-context-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
    let scopeServer: ReturnType<typeof createServer> | undefined;
    try {
      await mkdir(agentDir, { recursive: true });
      const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme, convertToLlm } = await import("@earendil-works/pi-coding-agent");
      const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
      const { createCompleteMcpClient } = await import("../complete.ts");
      const faux = fauxProvider({ provider: "context-consent-proof" });
      const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
        modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(faux.provider);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
      const sessionManager = SessionManager.inMemory(root);
      const scopeRequests: Array<{ method: string | undefined; path: string | undefined; rpc: string | undefined }> = [];
      let scopeUrl: string | undefined;
      if (!consent) {
        scopeServer = createServer(async (request, response) => {
          const record = { method: request.method, path: request.url, rpc: undefined as string | undefined };
          scopeRequests.push(record);
          if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404).end(); return; }
          let body = "";
          for await (const chunk of request) body += chunk;
          const message = JSON.parse(body);
          record.rpc = message.method;
          if (message.id === undefined) { response.writeHead(202).end(); return; }
          if (message.method === "tools/call") {
            response.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="write"' }).end("insufficient scope");
            return;
          }
          const result = message.method === "initialize"
            ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "scope-consent", version: "1" } }
            : message.method === "tools/list" ? { tools: [{ name: "restricted", inputSchema: { type: "object", properties: {} } }] } : undefined;
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
            ...(result ? { result } : { error: { code: -32601, message: "Method not found" } }) }));
        });
        await new Promise<void>(resolve => scopeServer!.listen(0, "127.0.0.1", resolve));
        const address = scopeServer.address();
        if (!address || typeof address === "string") throw new Error("Missing scope fixture address");
        scopeUrl = `http://127.0.0.1:${address.port}/mcp`;
      }
      const config: McpConfig = {
        mcpServers: Object.fromEntries(["alpha", "beta"].map(name => [name, {
          command: process.execPath, args: ["--input-type=module", "-e", serverSource],
          protocolVersion: "legacy", lifecycle: "eager", tasks: false,
          ...(ambiguousNames ? { toolPrefix: "none" } : {}),
        }])),
        settings: { samplingAutoApprove: true, directTools: false, autoAuth: false, elicitation: false },
      };
      if (scopeUrl) config.mcpServers.scope = { url: scopeUrl, oauth: false, protocolVersion: "legacy", lifecycle: "eager" };
      // Seed the actual session projection through Pi's public persistence API.
      // Results intentionally reuse tool names; only the originating call id distinguishes ownership.
      sessionManager.appendMessage({ role: "user", content: "private-user-conversation", timestamp: 1 });
      sessionManager.appendMessage(fauxAssistantMessage([
        { type: "text", text: "private-assistant-conversation" },
        fauxToolCall("mcp", { server: "alpha", tool: "echo" }, { id: "alpha-proxy" }),
        fauxToolCall("mcp", { server: "beta", tool: "echo" }, { id: "beta-proxy" }),
        fauxToolCall(ambiguousNames ? "echo" : "alpha_echo", {}, { id: "alpha-direct" }),
        fauxToolCall(ambiguousNames ? "echo" : "beta_echo", {}, { id: "beta-direct" }),
        fauxToolCall("alpha_echo_lookalike", {}, { id: "prefix-lookalike" }),
        fauxToolCall("mcp", { tool: "alpha_echo" }, { id: "unproven-proxy" }),
        fauxToolCall("read", { path: "secret" }, { id: "local-tool" }),
      ]));
      for (const [id, toolName, text] of [
        ["alpha-proxy", "mcp", "alpha-proxy-result"],
        ["beta-proxy", "mcp", "beta-proxy-secret"],
        ["alpha-direct", ambiguousNames ? "echo" : "alpha_echo", "alpha-direct-result"],
        ["beta-direct", ambiguousNames ? "echo" : "beta_echo", "beta-direct-secret"],
        ["prefix-lookalike", "alpha_echo_lookalike", "prefix-lookalike-secret"],
        ["unproven-proxy", "mcp", "unproven-proxy-secret"],
        ["local-tool", "read", "local-tool-secret"],
        ["orphan", "alpha_echo", "orphan-result-secret"],
      ]) sessionManager.appendMessage({ role: "toolResult", toolCallId: id!, toolName: toolName!,
        content: [{ type: "text", text: text! }], isError: false, timestamp: 2 });
      const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        disabledBuiltinExtensions: ["mcp"], extensionFactories: [createCompleteMcpClient({ config })] });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
        resourceLoader: loader, settingsManager, sessionManager, noTools: "builtin" }));
      initTheme("dark", false);
      const dialogs: Array<{ title: string; message: string }> = [];
      const errors: unknown[] = [];
      let expectedProjection: Message[] = [];
      await session.bindExtensions({ mode: ui ? "tui" : "print",
        ...(ui ? { uiContext: { ...session.extensionRunner.getUIContext(),
          confirm: async (title: string, message: string) => {
            dialogs.push({ title, message });
            if (title === "Share session context for MCP sampling?") expectedProjection = convertToLlm(sessionManager.buildSessionProjection().messages);
            return consent;
          }, notify() {},
        } } : {}), onError: error => errors.push(error) });
      const samplingContexts: TranscriptContext[] = [];
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("mcp", { server: "alpha", tool: "sample", args: { scope } })),
        ...(consent ? [(context: TranscriptContext) => {
          samplingContexts.push(context);
          return fauxAssistantMessage("authorized sampling response");
        }] : []),
        fauxAssistantMessage("Host workflow finished."),
      ]);
      await session.prompt("Request sampling from alpha using " + scope + " context.");
      expect(errors).toEqual([]);
      expect(faux.getPendingResponseCount()).toBe(0);
      expect(faux.state.callCount).toBe(consent ? 3 : 2);
      const consentDialogs = dialogs.filter(dialog => dialog.title === "Share session context for MCP sampling?");
      expect(consentDialogs).toHaveLength(ui ? 1 : 0);
      if (ui) expect(consentDialogs[0]?.message).toContain(`Server: alpha\nRequested scope: ${scope}`);
      expect(dialogs.some(dialog => dialog.title === "Approve MCP sampling request" || dialog.title === "Return MCP sampling response")).toBe(false);
      const result = session.messages.filter(message => message.role === "toolResult").at(-1);
      if (!consent) {
        expect(samplingContexts).toEqual([]);
        expect(result).toMatchObject({ toolName: "mcp", isError: true });
        expect(JSON.stringify(result?.content)).toContain("authorized getContext");
        // Expanded OAuth access has its own UI gate, unaffected by sampling auto-approval.
        const requestOffset = scopeRequests.length;
        const callCount = faux.state.callCount;
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("mcp", { server: "scope", tool: "restricted", args: {} })),
          fauxAssistantMessage("Expanded access was not approved."),
        ]);
        await session.prompt("Attempt the restricted tool while expanded OAuth access is declined.");
        const scopeResult = session.messages.filter(message => message.role === "toolResult").at(-1);
        expect(scopeResult).toMatchObject({ toolName: "mcp", isError: true });
        expect(dialogs.filter(dialog => dialog.title === "Approve expanded MCP OAuth access?")).toHaveLength(ui ? 1 : 0);
        if (ui) expect(dialogs.find(dialog => dialog.title === "Approve expanded MCP OAuth access?")?.message).toContain("Requested scopes: write");
        expect(scopeRequests.slice(requestOffset)).toEqual([{ method: "POST", path: "/mcp", rpc: "tools/call" }]);
        expect(faux.state.callCount).toBe(callCount + 2);
        expect(faux.getPendingResponseCount()).toBe(0);
      } else {
        expect(result).toMatchObject({ toolName: "mcp", isError: false });
        expect(samplingContexts).toHaveLength(1);
        const supplied = samplingContexts[0]!.messages;
        expect(supplied.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "sampling-request-only" }] });
        if (scope === "allServers") expect(supplied.slice(0, -1)).toEqual(expectedProjection);
        else {
          expect(supplied.slice(0, -1)).toEqual([
            { role: "user", content: [{ type: "text", text: "alpha-proxy-result" }], timestamp: 2 },
            ...(ambiguousNames ? [] : [{ role: "user", content: [{ type: "text", text: "alpha-direct-result" }], timestamp: 2 }]),
          ]);
          const serialized = JSON.stringify(supplied);
          for (const secret of ["private-user-conversation", "private-assistant-conversation", "beta-proxy-secret", "beta-direct-secret", "prefix-lookalike-secret", "unproven-proxy-secret", "local-tool-secret", "orphan-result-secret"])
            expect(serialized).not.toContain(secret);
        }
      }
    } finally {
      try {
        if (session) {
          await session.abort();
          try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
          finally { session.dispose(); }
        }
      } finally {
        if (scopeServer) {
          scopeServer.closeAllConnections();
          await new Promise<void>(resolve => scopeServer!.close(() => resolve()));
        }
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30000);
  }
});
