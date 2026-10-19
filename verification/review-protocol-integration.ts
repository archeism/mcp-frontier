import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } from "@earendil-works/pi-coding-agent";

const files = ["mcp-events.ts", "mcp-events-pi-delivery.ts", "mcp-events-coordinator.ts", "task-recovery-store.ts",
  "mcp-events-inbox.ts", "mcp-events-webhook-client.ts", "mcp-core.ts", "runtime-protocol.ts",
  "mcp-tasks.ts", "mcp-skills.ts", "server-manager.ts", "sampling-handler.ts", "elicitation-handler.ts", "http-ca.ts",
  "complete.ts", "mcp-events-registry.ts", "mcp-events-webhook.ts", "mcp-events-advanced.ts",
  "event-companion/src/stream.ts", "tool-registrar.ts", "index.ts", "direct-tools.ts", "ui-session.ts",
  "verification/live-codemode-tasks.ts", "verification/live-codemode-events-skills.ts", "verification/live-codemode-apps.ts",
  "__tests__/fixtures/native-codemode-apps.ts", "__tests__/fixtures/native-codemode-events-skills.ts"];
const hashes: Record<string, string> = {}, sources: string[] = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  hashes[file] = createHash("sha256").update(source).digest("hex");
  sources.push(`FILE ${file}\n${source}`);
}
const root = await mkdtemp(join(tmpdir(), "pi-protocol-review-")), agentDir = join(root, "agent");
await mkdir(agentDir);
const evidence = resolve("../verification-evidence", `gemini-protocol-review-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(evidence, { recursive: true });
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
  modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
await runtime.setRuntimeApiKey("google", (await readFile("/Users/cfeng1/.air/gemini-api-key", "utf8")).trim());
const model = runtime.getModel("google", "gemini-3.8-flash"); assert.ok(model);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
  noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"] });
await loader.reload();
const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, thinkingLevel: "off",
  resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), noTools: "builtin" });
await session.bindExtensions({ mode: "print" });
const started = Date.now();
let passed = false;
const timeout = setTimeout(() => { void session.abort(); }, 90000);
try {
  await session.prompt("Read-only independent security/correctness review of the exact source snapshots below. The current change establishes stock Pi 1.3 native codemode as the sole provider-facing tool, with our MCP tools callable underneath and mcpScript disabled. Focus on whether the new real-agent proofs actually exercise that contract end to end: Tasks input consent, nested tool identity/cancellation/recovery, Skills origin/integrity, idle Events wake-up/receipts, and a real MCP Apps browser with server-bound actions. Check the implementation paths for concrete regressions; distinguish scripted faux-model checks from real Gemini/browser evidence. Existing limits are intentional: aggregate retained inbox/task quotas, volatile explicitly in-memory sessions, no exactly-once remote effects or hardware power-loss durability, dynamic Skills require consent rather than static digests, private registry keys are stored with restrictive file permissions not encryption. Identify only concrete bugs with file/function and a reproducible sequence; distinguish hypotheses and missing surrounding code. Do not manufacture requirements or treat an unimplemented service/Durable adapter as a gap in this task. No implementation or commands. Return at most six findings, each with severity, evidence and minimal regression. If none, say so.\n\n" + sources.join("\n\n"));
  const assistant = session.messages.filter(message => message.role === "assistant");
  assert.equal(assistant.at(-1)?.stopReason, "stop", "Independent review did not complete normally");
  assert.ok(assistant.some(message => message.content.some(block => block.type === "text" && block.text.trim())), "Independent review was empty");
  passed = true;
} finally {
  clearTimeout(timeout); await session.abort();
  const assistant = session.messages.filter(message => message.role === "assistant");
  const report = assistant.flatMap(message => message.content.filter(block => block.type === "text").map(block => block.text)).join("\n");
  await writeFile(join(evidence, "result.json"), JSON.stringify({ passed, pi: "1.3.0", model: model.id, hashes, report,
    elapsedMs: Date.now() - started, maxRSS: process.resourceUsage().maxRSS, usage: assistant.map(message => message.usage),
    stopReasons: assistant.map(message => message.stopReason),
  }, null, 2));
  console.log(JSON.stringify({ passed, evidence, elapsedMs: Date.now() - started, report }));
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose(); await rm(root, { recursive: true, force: true });
}
