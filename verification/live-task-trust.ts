import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } from "@earendil-works/pi-coding-agent";
import { createCompleteMcpClient } from "../complete.ts";
import { startTaskTrustServer } from "../__tests__/fixtures/task-trust-server.mjs";

const evidence = resolve("../verification-evidence", `live-task-trust-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "pi-gemini-task-trust-"));
const previous = process.env.PI_CODING_AGENT_DIR;
const files = ["complete.ts", "mcp-tasks.ts", "task-recovery-store.ts", "server-manager.ts", "sampling-handler.ts", "elicitation-handler.ts"];
const hashes: Record<string, string> = {};
for (const file of files) hashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
const trials: unknown[] = [];
let passed = false;
try {
  assert.equal(JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version, "1.3.0");
  for (const era of process.argv.includes("--modern-only") ? ["modern"] : ["modern", "legacy"]) {
    const fixture = await startTaskTrustServer({ era, peerTimeoutMs: 30000, samplingMaxTokens: 2048 });
    const agentDir = join(root, era); await mkdir(agentDir); process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    await runtime.setRuntimeApiKey("google", (await readFile("/Users/cfeng1/.air/gemini-api-key", "utf8")).trim());
    const model = runtime.getModel("google", "gemini-3.8-flash"); assert.ok(model);
    const nested: unknown[] = [], approvals: string[] = [], errors: unknown[] = [], edits: string[] = [];
    const editedSystemPrompt = "Operator-reviewed prompt: return exactly TASK_SAMPLING_APPROVED_RESULT and no other text.";
    const complete = runtime.complete.bind(runtime);
    runtime.complete = async (model, context, options) => {
      assert.ok(approvals.includes("Approve MCP sampling request"));
      assert.equal(context.systemPrompt, editedSystemPrompt, "The actual provider must receive the operator's edited prompt");
      const result = await complete(model, context, options);
      nested.push({ model: result.model, stopReason: result.stopReason, usage: result.usage, content: result.content.filter(block => block.type === "text") });
      return result;
    };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" }); settingsManager.setRetryEnabled(false);
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"], extensionFactories: [createCompleteMcpClient({ config: {
        mcpServers: { trust: fixture.definition }, settings: { sampling: true, samplingAutoApprove: false, elicitation: true,
          approveTools: false, autoAuth: false, directTools: false, requestTimeoutMs: 60000 },
      } })] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), settingsManager, noTools: "builtin" });
    initTheme("dark", false);
    await session.bindExtensions({ mode: "tui", onError: error => errors.push(error), uiContext: { ...session.extensionRunner.getUIContext(),
      confirm: async title => { approvals.push(title); return true; },
      select: async (title, choices) => {
        approvals.push(title);
        if (title.startsWith("Review MCP sampling prompt") && !edits.length) return "Edit prompt";
        if (title.startsWith("Select prompt text")) { assert.ok(choices.includes("System prompt")); return "System prompt"; }
        return "Continue";
      },
      editor: async title => { assert.equal(title, "System prompt"); edits.push(editedSystemPrompt); return editedSystemPrompt; },
      notify() {} } });
    const started = Date.now(); let accepted = false;
    const timeout = setTimeout(() => { void session.abort(); }, 90000);
    try {
      await session.prompt("Use the configured MCP server trust to execute its sampling tool once, then its elicitation tool once. These are task-backed tools; wait for both terminal tool results. Do not describe instead of executing. Stop on any failure.");
      const report = fixture.report();
      assert.equal(report.taskCount, 2); assert.ok(report.tasks.every(task => task.terminal));
      assert.ok(nested.length > 0, "Missing real task-time sampling model call");
      assert.deepEqual(edits, [editedSystemPrompt], "Expected one operator prompt edit before sampling");
      assert.ok(approvals.includes("Approve MCP sampling request") && approvals.includes("Return MCP sampling response"));
      assert.ok(fixture.inputs.some(row => JSON.stringify(row.response).includes("TASK_SAMPLING_APPROVED_RESULT")));
      assert.ok(fixture.inputs.some(row => row.response.action === "accept"));
      assert.ok(report.clientMethods.includes(era === "modern" ? "tasks/update" : "tasks/result"));
      assert.deepEqual(report.violations, []); assert.deepEqual(errors, []);
      assert.equal(session.messages.filter(message => message.role === "toolResult" && message.isError).length, 0);
      accepted = true;
    } finally {
      clearTimeout(timeout); await session.abort();
      trials.push({ passed: accepted, era, pi: "1.3.0", model: model.id, report: fixture.report(), approvals, edits, errors, nested,
        elapsedMs: Date.now() - started, messages: session.messages });
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); await fixture.close();
    }
  }
  passed = true;
} finally {
  const endHashes: Record<string, string> = {};
  for (const file of files) endHashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  await writeFile(join(evidence, "result.json"), JSON.stringify({ passed, hashes, endHashes,
    sourceUnchanged: JSON.stringify(hashes) === JSON.stringify(endHashes), maxRSS: process.resourceUsage().maxRSS, trials }, null, 2));
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ passed, evidence, eras: (trials as Array<{ era: string }>).map(trial => trial.era) }));
}
