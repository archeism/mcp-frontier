import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createCompleteMcpClient } from "../../complete.ts";
import type {} from "./native-codemode-app.ts";

function resolveChrome() {
  for (const candidate of ["google-chrome", "google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("Chrome is required for native codemode MCP Apps browser verification");
}
const credentialMarker = "native-apps-fixture-credential-not-for-app";
const toolMarker = "NATIVE_CODEMODE_APP_RESULT";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(probe: () => Promise<T | undefined>, message: string, timeout = 30000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await probe(); if (value !== undefined) return value; await pause(50); }
  throw new Error(message);
}

async function upstream(label: string, html: string) {
  const calls: Array<{ name: string; args: unknown }> = [], authFailures: string[] = [];
  const sdk = new Server({ name: "untrusted-self-reported-name", version: "1" }, { capabilities: { tools: {}, resources: {} } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  sdk.setRequestHandler("tools/list", async () => ({ tools: [
    { name: "open_app", description: "Open the native codemode browser integration fixture", inputSchema: { type: "object", properties: {} },
      _meta: { ui: { resourceUri: "ui://native-codemode/app.html" } } },
    { name: "action", description: "Approved app action", inputSchema: { type: "object", properties: { phase: { type: "string" }, server: { type: "string" } }, required: ["phase"] }, _meta: { ui: { visibility: ["app"] } } },
    ...(label === "decoy" ? [{ name: "decoy_only", inputSchema: { type: "object" as const, properties: {} }, _meta: { ui: { visibility: ["app"] } } }] : []),
  ] }));
  sdk.setRequestHandler("resources/list", async () => ({ resources: [] }));
  sdk.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
  sdk.setRequestHandler("resources/read", async request => ({ contents: [{ uri: request.params.uri,
    mimeType: "text/html;profile=mcp-app", text: html }] }));
  sdk.setRequestHandler("tools/call", async request => {
    calls.push({ name: request.params.name, args: request.params.arguments });
    return { content: [{ type: "text", text: request.params.name === "open_app" ? toolMarker : `ACTION_BOUND_TO_${label.toUpperCase()}` }],
      structuredContent: { label, marker: toolMarker, arguments: request.params.arguments } };
  });
  await sdk.connect(transport);
  const http = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${credentialMarker}`) { authFailures.push(req.method ?? "unknown"); res.writeHead(401).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method ?? "GET", headers: req.headers as Record<string, string>,
        ...(["GET", "HEAD"].includes(req.method!) ? {} : { body: Buffer.concat(chunks), duplex: "half" } as object) });
      const response = await transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) { const reader = response.body.getReader(); res.on("close", () => { void reader.cancel().catch(() => {}); });
        while (true) { const part = await reader.read(); if (part.done) break; res.write(part.value); } }
      res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  return { calls, authFailures, url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`,
    async close() { await sdk.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}

async function browser(url: string, profile: string) {
  const chromePath = resolveChrome();
  const child = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
    "--host-resolver-rules=MAP localhost 127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  let socket: WebSocket | undefined;
  try {
    const port = await until(async () => { try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { return undefined; } }, "Chrome debugging endpoint missing");
    const target = await until(async () => { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      return pages.find(page => page.type === "page"); }, "Chrome page missing");
    socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Chrome CDP connection failed")); });
    let id = 0, acceptDialog = true;
    const dialogs: Array<{ message: string; accepted: boolean }> = [];
    const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void }>(), contexts = new Set<number>(), errors: unknown[] = [];
    socket.onmessage = event => { const data = JSON.parse(String(event.data));
      if (data.method === "Runtime.executionContextCreated") contexts.add(data.params.context.id);
      if (data.method === "Runtime.executionContextDestroyed") contexts.delete(data.params.executionContextId);
      if (data.method === "Runtime.exceptionThrown") errors.push(data.params.exceptionDetails.text);
      if (data.method === "Page.javascriptDialogOpening") {
        dialogs.push({ message: data.params.message, accepted: acceptDialog });
        void send("Page.handleJavaScriptDialog", { accept: acceptDialog }).catch(error => errors.push(String(error)));
      }
      const row = waiting.get(data.id); if (row) { waiting.delete(data.id); data.error ? row.reject(new Error(JSON.stringify(data.error))) : row.resolve(data.result); }
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const request = ++id;
      const timer = setTimeout(() => { waiting.delete(request); reject(new Error(`Chrome CDP timeout: ${method}`)); }, 5000);
      waiting.set(request, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      socket!.send(JSON.stringify({ id: request, method, params })); });
    await send("Runtime.enable"); await send("Page.enable");
    await send("Page.navigate", { url });
    const state = async () => {
      for (const contextId of contexts) {
        try { const row = await send("Runtime.evaluate", { contextId, expression: "document.querySelector('#fixture-state')?.textContent", returnByValue: true });
          if (row.result?.value) return { contextId, value: JSON.parse(row.result.value) }; } catch {} }
      return undefined;
    };
    return { errors, dialogs, send, state, setDialogDecision(value: boolean) { acceptDialog = value; },
      async click(name: string) { const current = await state(); assert.ok(current); await send("Runtime.evaluate", { contextId: current.contextId, expression: `document.getElementById(${JSON.stringify(name)}).click()` }); },
      async close() { socket?.close(); try { process.kill(-child.pid!, "SIGKILL"); } catch {} await pause(100); } };
  } catch (error) { socket?.close(); try { process.kill(-child.pid!, "SIGKILL"); } catch {} throw error; }
}

export async function runNativeCodemodeApps(mode: "faux" | "gemini", evidence: string) {
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "native-codemode-apps-")), agentDir = join(root, "agent"); await mkdir(agentDir);
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_MCP_CONFIG_MODE, viewer: process.env.MCP_UI_VIEWER };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_MCP_CONFIG_MODE = "exclusive"; process.env.MCP_UI_VIEWER = "none";
  const started = Date.now(), approvals: Array<{ title: string; decision: string }> = [], executionCalls: string[] = [], declarations: string[][] = [];
  let modelToolCalls: string[] = [], activeTools: string[] = [];
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined, chrome: Awaited<ReturnType<typeof browser>> | undefined;
  let origin: Awaited<ReturnType<typeof upstream>> | undefined, decoy: Awaited<ReturnType<typeof upstream>> | undefined;
  let passed = false, failure: string | undefined, browserState: unknown, usage: unknown;
  try {
    const bundle = await build({ entryPoints: [new URL("./native-codemode-app.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", platform: "browser" });
    const html = `<!doctype html><title>Native codemode MCP App</title><h1>Native codemode MCP App</h1><button id="allow">Approved action</button><button id="deny">Denied action</button><button id="cross">Cross-server attempt</button><pre id="fixture-state"></pre><script>${bundle.outputFiles[0]!.text}</script>`;
    origin = await upstream("origin", html); decoy = await upstream("decoy", html);
    const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const stream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (model, context, options) => {
      const names = getCurrentTools(context.messages).map(tool => tool.name);
      declarations.push(names);
      assert.deepEqual(names, ["codemode"], "Only native codemode may face the provider");
      return stream(model, context, options);
    };
    const faux = fauxProvider({ provider: "native-codemode-apps" }); runtime.registerNativeProvider(faux.provider);
    if (mode === "gemini") await runtime.setRuntimeApiKey("google", (await readFile("/Users/cfeng1/.air/gemini-api-key", "utf8")).trim());
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", codemode: { mode: "only" }, defaultTools: ["codemode"] }); settingsManager.setRetryEnabled(false);
    const definition = (url: string) => ({ url, protocolVersion: "legacy" as const, auth: false as const, tasks: false, lifecycle: "eager" as const, headers: { Authorization: `Bearer ${credentialMarker}` } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      disabledBuiltinExtensions: ["mcp"], extensionFactories: [createCodemodeExtension({ mode: "only", models: false }), createCompleteMcpClient({
        config: { mcpServers: { origin: definition(origin.url), decoy: definition(decoy.url) }, settings: { directTools: "search", approveTools: true, autoAuth: false, sampling: false, elicitation: false } },
      })] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: mode === "faux" ? faux.getModel() : runtime.getModel("google", "gemini-3.8-flash")!, thinkingLevel: "off",
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
    initTheme("dark", false);
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), notify() {}, confirm: async () => true,
      select: async (title, choices) => { const decision = title.includes('"deny"') || title.includes('"phase": "deny"') ? "Deny" : choices.includes("Allow once") ? "Allow once" : choices[0]!;
        approvals.push({ title, decision }); return decision; } } });
    session.setActiveToolsByName(["codemode"]);
    activeTools = session.getActiveToolNames(); assert.deepEqual(activeTools, ["codemode"]);
    session.subscribe(event => { if (event.type === "tool_execution_start") executionCalls.push(event.toolName); });
    if (mode === "faux") faux.setResponses([async context => {
      return fauxAssistantMessage(fauxToolCall("codemode", { code: 'const t = ALL_TOOLS.find(t => t.name.includes("origin") && t.name.includes("open_app")); if (!t) throw Error("app tool missing"); text(await tools[t.name]({}));' }));
    }, fauxAssistantMessage("App opened.")]);
    const timer = setTimeout(() => { void session!.abort(); }, 90000);
    try { await session.prompt("Use only native codemode. Find and call open_app on the origin MCP server through codemode tools (not the decoy). Open it once, then finish. Do not call its action tools; the human will use the browser app."); }
    finally { clearTimeout(timer); }
    assert.ok(declarations.length > 0, "Actual provider tool declarations must be captured");
    assert.ok(declarations.every(names => JSON.stringify(names) === '["codemode"]'), "Only native codemode may face the provider");
    const messages = session.messages;
    const assistantCalls = messages.filter(message => message.role === "assistant").flatMap(message => message.content.filter(block => block.type === "toolCall").map(block => block.name));
    modelToolCalls = assistantCalls;
    assert.ok(assistantCalls.length > 0); assert.ok(assistantCalls.every(name => name === "codemode"), JSON.stringify(assistantCalls));
    assert.equal(origin.calls.filter(call => call.name === "open_app").length, 1); assert.equal(decoy.calls.length, 0);
    const output = JSON.stringify(messages.filter(message => message.role === "toolResult"));
    assert.ok(output.includes(toolMarker)); assert.ok(!output.includes(credentialMarker));
    const url = output.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+[^\s"\\]*/)?.[0];
    assert.ok(url, "Native codemode must return a live MCP Apps bridge URL");
    chrome = await browser(url, join(root, "chrome"));
    const app = await until(async () => { const row = await chrome!.state(); return row?.value.initialized && row.value.result ? row : undefined; }, "Official App SDK initialize/tool-result did not complete");
    assert.ok(JSON.stringify(app.value.result).includes(toolMarker)); assert.deepEqual(app.value.errors, []);
    chrome.setDialogDecision(false); await chrome.click("allow");
    await until(async () => { const row = await chrome!.state(); return row?.value.actions.length === 1 ? row : undefined; }, "Browser consent denial did not settle");
    assert.equal(origin.calls.filter(call => call.name === "action").length, 0);
    assert.equal(approvals.length, 1, "Browser denial must not reach the Pi tool approval gate");
    chrome.setDialogDecision(true);
    for (const [index, phase] of ["allow", "deny", "cross"].entries()) {
      await chrome.click(phase);
      await until(async () => { const row = await chrome!.state(); return row?.value.actions.length === index + 2 ? row : undefined; }, `App action ${phase} did not settle`);
    }
    browserState = (await chrome.state())!.value;
    assert.ok(JSON.stringify(browserState).includes("ACTION_BOUND_TO_ORIGIN"));
    assert.equal(origin.calls.filter(call => call.name === "action").length, 1);
    assert.equal(decoy.calls.length, 0); assert.ok(approvals.some(row => row.decision === "Deny"));
    const bridge = new URL(url); const before = origin.calls.length;
    const unauthorized = await fetch(new URL("/proxy/tools/call", bridge), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ params: { name: "action", arguments: { phase: "allow" } } }) });
    assert.equal(unauthorized.status, 403); assert.equal(origin.calls.length, before);
    assert.deepEqual(origin.authFailures, []); assert.deepEqual(decoy.authFailures, []);
    assert.ok(!JSON.stringify(browserState).includes(credentialMarker));
    const screenshot = await chrome.send("Page.captureScreenshot", { format: "png" }); await writeFile(join(evidence, "app.png"), Buffer.from(screenshot.data, "base64"));
    usage = messages.filter(message => message.role === "assistant").map(message => message.usage);
    passed = true;
  } catch (error) { failure = String(error); throw error; }
  finally {
    await writeFile(join(evidence, "result.json"), JSON.stringify({ passed, failure, mode, pi: "1.3.0", activeTools, modelToolCalls, executionCalls, declarations, approvals,
      browserState, browserDialogs: chrome?.dialogs, browserErrors: chrome?.errors, originCalls: origin?.calls, decoyCalls: decoy?.calls, usage, elapsedMs: Date.now() - started, maxRSS: process.resourceUsage().maxRSS }, null, 2));
    if (chrome) await chrome.close();
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    await origin?.close(); await decoy?.close();
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["PI_MCP_CONFIG_MODE", saved.config], ["MCP_UI_VIEWER", saved.viewer]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { passed, evidence, elapsedMs: Date.now() - started };
}
