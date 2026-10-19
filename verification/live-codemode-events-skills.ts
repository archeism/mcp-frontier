import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCodemodeHost, proveEvents, proveSkills } from "../__tests__/fixtures/native-codemode-events-skills.ts";

// One serial Gemini workflow, <=10 MiB retained evidence, no store copies or
// external deployments. The key is read by ModelRuntime only; never serialized.
const files = ["complete.ts", "index.ts", "mcp-events.ts", "mcp-events-coordinator.ts", "mcp-events-pi-delivery.ts", "mcp-events-inbox.ts",
  "mcp-events-registry.ts", "mcp-events-webhook-client.ts", "mcp-skills.ts", "runtime-protocol.ts", "server-manager.ts",
  "__tests__/native-codemode-events-skills.test.ts", "__tests__/fixtures/native-codemode-events-skills.ts", "verification/live-codemode-events-skills.ts"];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
const before = await hashes(), started = Date.now();
const evidence = resolve("../verification-evidence", `live-codemode-events-skills-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const host = await createCodemodeHost(true);
const timeout = setTimeout(() => { void host.session.abort(); }, 240000);
let passed = false, failure: string | undefined;
let eventChecks: Awaited<ReturnType<typeof proveEvents>> = [];
try {
  eventChecks = await proveEvents(host);
  await proveSkills(host);
  assert.deepEqual(host.replayProof(), { reconciled: true, duplicateMessages: 0, automaticTurns: 0, automaticProviderRequests: 0 });
  assert.ok(host.providerTools.length > 6);
  assert.ok(host.providerTools.every(names => JSON.stringify(names) === '["codemode"]'), "Provider saw tools other than native codemode");
  assert.ok(host.nested.some(row => row.name === "mcp_events" && row.parent));
  assert.ok(host.nested.some(row => row.name === "mcp_skills" && row.parent));
  assert.deepEqual(host.errors, []);
  assert.deepEqual(await hashes(), before, "Source changed during live proof");
  passed = true;
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  clearTimeout(timeout); await host.session.abort();
  const receipts = await host.receipts();
  const usage = host.session.messages.filter(m => m.role === "assistant").map(m => m.usage);
  const result = { passed, failure, pi: "1.3.0", model: host.model, providerMode: "real-gemini", proofRevision: "event-derived-nonce-and-reconciled-restart",
    supersedesLimitedEvidence: ["live-codemode-events-skills-2026-10-19T13-07-37.651Z", "live-codemode-events-skills-2026-10-19T13-10-02.184Z"],
    priorEvidenceLimits: "Earlier passing runs used a prompt-known answer and checked absence of restart replay only over a fixed 250ms window.",
    nativeCodemode: { mode: "only", scriptMode: false },
    elapsedMs: Date.now() - started, maxRSS: process.resourceUsage().maxRSS, usage,
    eventChecks, skillsChecks: passed, restart: { persistent: true, heldAckFailures: host.ackFailures, ...host.replayProof(),
      observationBoundary: "Actual pending ACK reconciliation, restoration list query, and all later Skills turns; not an unbounded no-replay claim." },
    providerTools: host.providerTools, nested: host.nested, approvals: host.approvals,
    callbacks: host.callbacks, wire: host.wire, errors: host.errors, expectedErrors: host.expectedErrors,
    hashes: before, endHashes: await hashes(), messages: host.session.messages };
  const raw = JSON.stringify(result, null, 2), transcript = receipts.map(row => JSON.stringify(row)).join("\n") + "\n";
  assert.ok(!raw.includes("whsec_"), "Unexpected webhook secret in public proof output");
  assert.ok(Buffer.byteLength(raw) + Buffer.byteLength(transcript) <= 10 * 1024 * 1024, "Evidence exceeds 10 MiB budget");
  await writeFile(join(evidence, "result.json"), raw, { mode: 0o600 });
  await writeFile(join(evidence, "session.jsonl"), transcript, { mode: 0o600 });
  const bytes = (await stat(join(evidence, "result.json"))).size + (await stat(join(evidence, "session.jsonl"))).size;
  await host.close();
  console.log(JSON.stringify({ passed, evidence, elapsedMs: Date.now() - started, evidenceBytes: bytes, eventChecks, failure }));
}
if (!passed) process.exitCode = 1;
