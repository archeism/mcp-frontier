import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore, getCurrentTools } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { Harness, createRegistry, type Conversation } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createDurableFrontier } from "./frontier.ts";
import { startDurableFixture } from "./fixture.ts";

const background = BACKGROUND_CONTEXT;
const context = withAbortSignal(AbortSignal.timeout(180000), background);
const rootDir = await mkdtemp(join(tmpdir(), "frontier-pi-durable-"));
const evidenceDir = resolve("../verification-evidence", `pi-durable-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(evidenceDir, { recursive: true });
const started = Date.now();
const fixture = await startDurableFixture();
const credentials = new InMemoryCredentialStore();
await credentials.modify("google", async () => ({ type: "api_key",
  key: (await readFile(process.env.GEMINI_API_KEY_FILE ?? "/Users/cfeng1/.air/gemini-api-key", "utf8")).trim() }));
const models = createModels({ credentials }); models.setProvider(googleProvider());
assert.ok(models.getModel("google", "gemini-3.8-flash"));
const requests: string[][] = [], errors: string[] = [];
const stream = models.streamSimple.bind(models);
models.streamSimple = (model, transcript, options) => {
  const names = getCurrentTools(transcript.messages).map(tool => tool.name);
  requests.push(names); assert.deepEqual(names, ["codemode"]);
  return stream(model, transcript, options);
};
let active: Awaited<ReturnType<typeof open>> | undefined;
async function open() {
  const bridge = await createDurableFrontier({ directory: join(rootDir, "frontier"), servers: { fixture: fixture.definition },
    onError: error => errors.push(String(error)) });
  const registry = createRegistry(); registry.install(bridge.extension);
  const code = createCodemodeExtension({ sandbox: new CodemodeSandbox(), models: false }); registry.install(code);
  const env = new NodeExecutionEnv({ cwd: rootDir });
  const harness = await Harness.open(await openNodeSqliteStorage(join(rootDir, "durable.sqlite")), {
    models, registry, env: () => env, onReport: error => errors.push(String(error)),
    settings: { retry: { maxRetries: 0 } },
  }, context);
  const conversation = await harness.root(context, { agent: { model: { provider: "google", modelId: "gemini-3.8-flash" },
    modelTools: [code.tools![0]!], thinkingLevel: "off" } });
  await bridge.attach(conversation, context);
  return { bridge, harness, conversation,
    async close() { await harness.close(background); await bridge.close(); await env.cleanup(background); } };
}
async function entries(conversation: Conversation) {
  return (await conversation.entries({ order: "ascending" }, 1000, undefined, context)).items;
}
const script = `const a=await tools.frontier_tools({server:"fixture",action:"call",name:"read_secret",arguments:{}});
const b=await tools.frontier_tools({server:"fixture",action:"call",name:"task_read",arguments:{}});
const sub=await tools.frontier_events({action:"subscribe",server:"fixture",name:"update",delivery:"poll"});
text({a,b,sub});`;
const input = { type: "input" as const, requestId: "frontier-prototype-initial",
  content: `Run this exact script with codemode once, then report its nonce and value. Do not make additional MCP calls.\n${script}\nFor a later MCP update event, use codemode to multiply delivery.data.a by delivery.data.b, text the result with its nonce, then report it. Do not subscribe again.` };
let accepted = false;
try {
  active = await open();
  const first = await active.conversation.submit(input, context);
  assert.equal((await first.wait(context)).status, "done");
  const initial = await entries(active.conversation);
  const output = JSON.stringify(initial.filter(entry => entry.kind === "pi.tool-result"));
  assert.ok(output.includes(fixture.toolValue.nonce), "Actual codemode output contains the MCP-only nonce");
  assert.ok(output.includes(String(fixture.toolValue.value)));
  assert.equal(fixture.calls.filter(call => call.name === "read_secret").length, 1);
  assert.equal(fixture.calls.filter(call => call.name === "task_read").length, 1);
  assert.ok(fixture.wire.some(frame => frame.method === "tasks/get"), "MCP Tasks actually polled");
  const event = fixture.arm();
  const deadline = Date.now() + 60000;
  let delivered = initial;
  while (!JSON.stringify(delivered.filter(entry => entry.kind === "pi.tool-result")).includes(event.nonce)) {
    assert.ok(Date.now() < deadline, "MCP event wakes actual Durable agent and runs codemode");
    await new Promise(resolve => setTimeout(resolve, 100));
    delivered = await entries(active.conversation);
  }
  await active.bridge.flush(); await active.conversation.waitForIdle(context);
  delivered = await entries(active.conversation);
  const eventOutputs = JSON.stringify(delivered.filter(entry => entry.kind === "pi.tool-result"));
  assert.ok(eventOutputs.includes(String(BigInt(event.a) * BigInt(event.b))), "Exact integer product is in actual code-mode output");
  const conversationId = active.conversation.id;
  const beforeRestart = requests.length;
  const entryIds = delivered.map(entry => entry.id);
  const usage = await active.harness.usage(context);
  await active.close(); active = undefined;
  active = await open();
  assert.equal(active.conversation.id, conversationId);
  const again = await active.conversation.submit(input, context);
  assert.equal(again.id, first.id, "Persisted request identity survives reopen");
  assert.equal((await again.wait(context)).status, "done");
  // Fixture repeats the same event on every poll, including after reopen.
  await new Promise(resolve => setTimeout(resolve, 2300));
  await active.bridge.flush(); await active.conversation.waitForIdle(context);
  assert.deepEqual((await entries(active.conversation)).map(entry => entry.id), entryIds);
  assert.equal(requests.length, beforeRestart, "No extra provider calls on duplicate delivery/reopen");
  assert.equal(fixture.calls.length, 2, "No repeated remote tool effects");
  assert.deepEqual(errors, []);
  accepted = true;
  const result = { status: "passed", piDurable: "1.3.0", model: "google/gemini-3.8-flash", rootDir,
    conversationId, providerRequests: requests, calls: fixture.calls, wire: fixture.wire, usage,
    event, elapsedMs: Date.now() - started, errors, processResourceUsage: process.resourceUsage(),
    resourceLimits: "Main Node process only; worker CPU/memory not independently attributed. Not a performance benchmark.",
    sourceHashes: Object.fromEntries(await Promise.all(["frontier.ts", "fixture.ts", "live.ts"].map(async file =>
      [file, createHash("sha256").update(await readFile(new URL(file, import.meta.url))).digest("hex")]))),
    limitations: ["Graceful SQLite close/reopen, not SIGKILL recovery", "Native adapter prototype, not all Pi CLI surfaces", "Uncertain MCP effects are unsafe to replay"] };
  await writeFile(join(evidenceDir, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(join(evidenceDir, "entries.json"), JSON.stringify(delivered, null, 2));
  console.log(JSON.stringify({ status: "passed", evidenceDir, providerCalls: requests.length, elapsedMs: result.elapsedMs }));
} finally {
  await active?.close(); await fixture.close();
  if (!accepted) await writeFile(join(evidenceDir, "failure.json"), JSON.stringify({ status: "failed", requests, errors, elapsedMs: Date.now() - started }));
}
