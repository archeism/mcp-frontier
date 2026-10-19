import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { startTaskTrustServer } from "../__tests__/fixtures/task-trust-server.mjs";

// Shared actual-Pi host, also used by the deterministic characterization. No
// replacement task driver or mock production modules; only the provider varies.
export async function nativeHost(era: "modern" | "legacy", live = false) {
  const fixture = await startTaskTrustServer({ era, peerTimeoutMs: live ? 30000 : 2000, samplingMaxTokens: 2048 });
  const root = await mkdtemp(join(tmpdir(), "native-codemode-tasks-")), agentDir = join(root, "agent");
  await mkdir(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_MCP_CONFIG_MODE: process.env.PI_MCP_CONFIG_MODE };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_MCP_CONFIG_MODE = "exclusive";
  // A controlled session-expiry gateway around the reusable SDK fixture. A
  // reconnect gets a new HTTP session while the backend retains the task.
  let initialized: any, upstreamSession: string | undefined, sessions = 0, expire = false;
  const gateway = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks), frame = body.length ? JSON.parse(body.toString()) : undefined;
      if (expire && frame?.method === "tasks/get") { expire = false; res.writeHead(404, { "mcp-session-id": String(req.headers["mcp-session-id"] ?? "expired") }).end(); return; }
      if (frame?.method === "initialize" && initialized) {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `gateway-${++sessions}` })
          .end(JSON.stringify({ ...initialized, id: frame.id })); return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value && !["host", "connection", "content-length"].includes(key)) headers.set(key, String(value));
      if (upstreamSession && headers.has("mcp-session-id")) headers.set("mcp-session-id", upstreamSession);
      const response = await fetch(fixture.url, { method: req.method ?? "GET", headers, ...(["GET", "HEAD"].includes(req.method ?? "GET") ? {} : { body }) });
      const outgoing = Object.fromEntries(response.headers);
      if (frame?.method === "initialize") {
        upstreamSession = response.headers.get("mcp-session-id") ?? undefined;
        const raw = await response.text();
        initialized = JSON.parse(raw.startsWith("event:") || raw.startsWith("data:") ? raw.split("\n").find(line => line.startsWith("data:"))!.slice(5).trim() : raw);
        outgoing["content-type"] = "application/json"; delete outgoing["content-length"];
        outgoing["mcp-session-id"] = `gateway-${++sessions}`;
        res.writeHead(response.status, outgoing).end(JSON.stringify(initialized)); return;
      }
      res.writeHead(response.status, outgoing);
      const reader = response.body?.getReader();
      if (reader) { res.on("close", () => { void reader.cancel().catch(() => {}); });
        for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); } }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end("Fixture gateway failure"); }
  });
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/mcp`;
  await writeFile(join(agentDir, "mcp-adapter.json"), JSON.stringify({ mcpServers: { trust: { ...fixture.definition, url } },
    settings: { sampling: true, samplingAutoApprove: false, elicitation: true, approveTools: false,
      directTools: "search", autoAuth: false, scriptMode: false, requestTimeoutMs: live ? 60000 : 5000 } }));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxProvider({ provider: "native-codemode-tasks" });
  if (live) await runtime.setRuntimeApiKey("google", (await readFile("/Users/cfeng1/.air/gemini-api-key", "utf8")).trim());
  else runtime.registerNativeProvider(faux.provider);
  const model = live ? runtime.getModel("google", "gemini-3.8-flash")! : faux.getModel(); assert.ok(model);
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], compaction: { enabled: false }, cacheWarming: "off" });
  settingsManager.setRetryEnabled(false);
  const approvals: string[] = [], errors: unknown[] = [], providerTools: string[][] = [], nested: unknown[] = [];
  let decision: "accept" | "decline" | "hold" = "accept", held: (() => void) | undefined;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"],
    additionalExtensionPaths: [process.env.PI_MCP_COMPLETE_PACKED_ENTRY ?? fileURLToPath(new URL("../complete.ts", import.meta.url))],
    extensionFactories: [createCodemodeExtension({ mode: "only" })] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, thinkingLevel: "off",
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(root, join(root, "sessions")), noTools: "builtin", tools: ["+codemode"] });
  let samplingDepth = 0;
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    if (!samplingDepth) {
      providerTools.push(getCurrentTools(context.messages).map(tool => tool.name));
      assert.deepEqual(providerTools.at(-1), ["codemode"], "Only native codemode may face the outer provider");
    }
    return stream(model, context, options);
  };
  const complete = runtime.complete.bind(runtime);
  runtime.complete = async (model, context, options) => {
    assert.ok(approvals.includes("Approve MCP sampling request"), "approval precedes nested provider call");
    samplingDepth++;
    try {
      const result = await complete(model, context, options);
      nested.push({ stopReason: result.stopReason, usage: result.usage, content: result.content }); return result;
    } finally { samplingDepth--; }
  };
  initTheme("dark", false);
  await session.bindExtensions({ mode: "tui", onError: error => errors.push(error), uiContext: { ...session.extensionRunner.getUIContext(),
    confirm: async title => { approvals.push(title); if (decision === "hold") await new Promise<void>(resolve => { held = resolve; }); return decision === "accept"; },
    select: async title => { approvals.push(title); if (decision === "hold") await new Promise<void>(resolve => { held = resolve; }); return decision === "accept" ? "Continue" : "Decline"; }, notify() {} } });
  return { fixture, session, faux, fauxAssistantMessage, fauxToolCall, approvals, errors, providerTools, nested,
    decide(value: typeof decision) { decision = value; }, release() { held?.(); held = undefined; },
    expire() { assert.equal(era, "legacy"); expire = true; }, sessions: () => sessions,
    async close() { decision = "decline"; held?.(); await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
      await fixture.close(); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve()));
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true }); } };
}

export const happyCode = 'const s = await tools.trust_sampling({}); const e = await tools.trust_elicitation({}); if (!Array.isArray(s.content) || !Array.isArray(e.content)) throw Error("Missing structured MCP envelopes"); text({ sampling: s, elicitation: e });';

async function main() {
  const evidence = resolve("../verification-evidence", `live-codemode-tasks-${new Date().toISOString().replaceAll(":", "-")}`);
  await mkdir(evidence, { recursive: true }); const trials: unknown[] = []; let passed = false;
  try {
    for (const era of ["modern", "legacy"] as const) {
      const h = await nativeHost(era, true); const started = Date.now();
      const timeout = setTimeout(() => { h.release(); void h.session.abort(); }, 120000);
      let accepted = false;
      try {
        if (era === "legacy") h.expire();
        await h.session.prompt(`Run exactly one codemode script: ${happyCode} Do not call models directly; the task-backed sampling tool does its own approved nested sampling. After the script returns, say NATIVE_CODEMODE_TASKS_OK.`);
        assert.ok(h.providerTools.length); assert.ok(h.nested.length);
        assert.ok(h.approvals.includes("Return MCP sampling response"));
        assert.ok(h.fixture.inputs.some(row => JSON.stringify(row.response).includes("TASK_SAMPLING_APPROVED_RESULT")));
        assert.ok(h.fixture.inputs.some(row => row.response.action === "accept"));
        assert.equal(h.fixture.tasks.size, 2); assert.ok([...h.fixture.tasks.values()].every(task => task.done));
        const results = h.session.messages.filter(message => message.role === "toolResult");
        assert.ok(results.some(result => result.toolName === "codemode" && !result.isError));
        assert.ok(results.some(result => result.nestedCalls?.calls.some(call => call.name === "trust_sampling" && call.status === "ok")));
        assert.deepEqual(h.fixture.violations, []); assert.deepEqual(h.errors, []);
        if (era === "legacy") assert.equal(h.sessions(), 2);
        accepted = true;
      } finally {
        clearTimeout(timeout); trials.push({ era, passed: accepted, elapsedMs: Date.now() - started, providerTools: h.providerTools,
          approvals: h.approvals, nested: h.nested, report: h.fixture.report(), messages: h.session.messages }); await h.close();
      }
    }
    passed = true;
  } finally {
    await writeFile(join(evidence, "result.json"), JSON.stringify({ passed, trials, maxRSS: process.resourceUsage().maxRSS }, null, 2));
    console.log(JSON.stringify({ passed, evidence }));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
