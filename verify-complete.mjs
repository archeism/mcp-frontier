import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const runId = new Date().toISOString().replaceAll(":", "-");
const evidence = resolve(root, "..", "verification-evidence", runId);
mkdirSync(evidence, { recursive: true });
const ignored = new Set(["node_modules", "dist", ".git", ".codegraph", ".pi", "results", "results-auth"]);
function sourceDigest() {
  const digest = createHash("sha256");
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.name === "VERIFICATION.json" || /\.(?:tgz|log)$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) { digest.update(path.slice(root.length)); digest.update("\0"); digest.update(readFileSync(path)); digest.update("\0"); }
    }
  }
  visit(root); return digest.digest("hex");
}
const versions = Object.fromEntries([
  "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui",
  "@modelcontextprotocol/client", "@modelcontextprotocol/core", "@modelcontextprotocol/ext-tasks",
  "@modelcontextprotocol/conformance",
].map(name => [name, JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version]));
const manifest = {
  runId, sourceSha256: sourceDigest(), sourceUnchanged: false, versions,
  nodeVersion: process.version,
  startedAt: new Date().toISOString(), finishedAt: null, status: "running", steps: [],
  conformanceExceptions: ["auth/2025-03-26-oauth-metadata-backcompat: inconsistent issuer metadata rejected; strict validation retained"],
  hostEvidence: "Actual Pi 1.3 extension file loader and agent kernel; official scripted faux model, not a live provider",
  limits: [
    "Pi 1.3 cannot represent native audio/assistant-image/arbitrary-binary sampling messages; explicit errors, not silent conversions",
    "Experimental Events webhook ingress requires operator-provided HTTPS receiver configuration; all three delivery modes are tested, not public infrastructure deployment",
    "Packed Linux native-keyring recovery test is platform-skipped on macOS; not claimed verified",
    "Modern ping/log-level requests are rejected by official SDK version policy; legacy wire support is tested",
    "Persistent Events consumption requires version-2 disk receipts; explicit in-memory Pi sessions are volatile and old unconfirmed pending deliveries may replay",
  ],
  independentReview: {
    nativeAgent: "Completed; origin-collision and approval-dialog cancellation defects reproduced, fixed and regression-tested",
    differentHarness: "Pi 1.3/Gemini independent reviews retained under verification-evidence; findings require source-backed adjudication and regressions. Earlier unavailable Claude Code attempt is not counted.",
  },
  skillDecision: "No skill revision; loaded operating skills unchanged. Product regressions encode observed failures.",
  operatingSkillHashes: Object.fromEntries([
    ["csuite:rsi-loop", "/Users/cfeng1/.codex/plugins/cache/personal/csuite/0.3.0/skills/rsi-loop/SKILL.md"],
    ["csuite:factory-mode", "/Users/cfeng1/.codex/plugins/cache/personal/csuite/0.3.0/skills/factory-mode/SKILL.md"],
    ["csuite:process-engineering", "/Users/cfeng1/.codex/plugins/cache/personal/csuite/0.3.0/skills/process-engineering/SKILL.md"],
    ["toolbox:ponytail", "/Users/cfeng1/.codex/plugins/cache/personal/toolbox/0.2.0/skills/ponytail/SKILL.md"],
    ["addy:api-and-interface-design", "/Users/cfeng1/personal/plugins/addy/skills/api-and-interface-design/SKILL.md"],
    ["addy:test-driven-development", "/Users/cfeng1/personal/plugins/addy/skills/test-driven-development/SKILL.md"],
  ].map(([name, path]) => [name, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null])),
  rawEvidenceDirectory: evidence,
  diskBudget: { minimumFreeBytes: 1024 * 1024 * 1024, maximumArchiveBytes: 256 * 1024 * 1024 },
};
function save() { writeFileSync(join(root, "VERIFICATION.json"), JSON.stringify(manifest, null, 2) + "\n"); }
function run(name, args, options = {}) {
  console.log(`Verifying ${name}...`);
  const started = Date.now();
  const result = spawnSync("bun", args, {
    cwd: options.cwd ?? root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 600000,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  writeFileSync(join(evidence, name + ".stdout.txt"), result.stdout ?? "");
  writeFileSync(join(evidence, name + ".stderr.txt"), result.stderr ?? "");
  manifest.steps.push({ name, command: ["bun", ...args], exitCode: result.status, wallMs: Date.now() - started,
    error: result.error?.message ?? null });
  save();
  if (result.status !== 0 || result.error) throw new Error(`${name} failed; inspect ${evidence}`);
}
try {
  const disk = statfsSync(root);
  manifest.diskBefore = { availableBytes: disk.bavail * disk.bsize };
  if (manifest.diskBefore.availableBytes < manifest.diskBudget.minimumFreeBytes) throw new Error("Insufficient free disk for bounded verification/checkpoint scratch");
  if (versions["@earendil-works/pi-coding-agent"] !== "1.3.0" || versions["@modelcontextprotocol/ext-tasks"] !== "0.2.2")
    throw new Error("Wrong target host or Tasks SDK version; install the frozen lockfile first");
  run("typecheck", ["run", "typecheck"]);
  run("native-codemode-typecheck", ["run", "typecheck:native-codemode"]);
  run("public-build", ["run", "build:public"]);
  if (!existsSync(join(root, "examples/interactive-visualizer/dist/app.html")))
    run("visualizer-build", ["run", "build"], { cwd: join(root, "examples/interactive-visualizer") });
  // Match test-runner.mjs: browser work gets its own phase rather than racing
  // unrelated subprocess tests. Both phases are counted; no cases are skipped.
  run("vitest", ["run", "test:vitest", "--exclude", "__tests__/ui-server-browser.test.ts", "--exclude", "__tests__/native-codemode-apps.test.ts", "--maxWorkers=2", "--minWorkers=1", "--reporter=json", "--outputFile=" + join(evidence, "vitest.json")]);
  run("browser", ["run", "test:vitest", "__tests__/ui-server-browser.test.ts", "__tests__/native-codemode-apps.test.ts", "--maxWorkers=1", "--reporter=json", "--outputFile=" + join(evidence, "browser.json")]);
  manifest.tests = { passed: 0, failed: 0, pending: 0, total: 0 };
  for (const name of ["vitest", "browser"]) {
    const tests = JSON.parse(readFileSync(join(evidence, name + ".json"), "utf8"));
    manifest.tests.passed += tests.numPassedTests; manifest.tests.failed += tests.numFailedTests;
    manifest.tests.pending += tests.numPendingTests; manifest.tests.total += tests.numTotalTests;
  }
  if (manifest.tests.failed || manifest.tests.pending) throw new Error("Tests failed or skipped; do not claim complete coverage");
  run("oauth", ["run", "test:oauth"]);
  manifest.oauthTestSummary = readFileSync(join(evidence, "oauth.stdout.txt"), "utf8").split("\n").filter(line => /(?:tests|pass|fail|skipped) \d+/.test(line)).slice(-4);
  run("packed-exports-and-pi-host", ["run", "test:public-exports"]);
  manifest.packageTestSummary = readFileSync(join(evidence, "packed-exports-and-pi-host.stdout.txt"), "utf8").split("\n").filter(line => /(?:tests|pass|fail|skipped) \d+/.test(line)).slice(-4);
  run("official-conformance", ["run", "test:conformance"], { env: { CONFORMANCE_RESULTS_DIR: join(evidence, "conformance") } });
  run("live-gemini", ["run", "test:live-gemini"], { timeout: 240000 });
  run("live-events-delivery", ["run", "test:live-events-delivery"], { timeout: 120000 });
  run("live-events-modes", ["run", "test:live-events-modes"], { timeout: 240000 });
  run("live-task-trust", ["run", "test:live-task-trust"], { timeout: 240000 });
  run("live-codemode-tasks", ["run", "test:live-codemode-tasks"], { timeout: 240000 });
  run("live-codemode-events-skills", ["run", "test:live-codemode-events-skills"], { timeout: 300000 });
  run("live-codemode-apps", ["run", "test:live-codemode-apps"], { timeout: 240000 });
  run("gemini-independent-review", ["run", "test:review-protocol"], { timeout: 180000 });
  const reviewLines = readFileSync(join(evidence, "gemini-independent-review.stdout.txt"), "utf8").trim().split("\n");
  manifest.independentReview.currentSnapshot = JSON.parse(reviewLines.at(-1));
  if (!manifest.independentReview.currentSnapshot.passed) throw new Error("Independent review did not complete; launcher exit is not acceptance");
  manifest.independentReview.adjudication = "pending: inspect each finding against source and regressions before declaring the goal complete";
  manifest.liveEvidence = ["live-gemini", "live-events-delivery", "live-events-modes", "live-task-trust",
    "live-codemode-tasks", "live-codemode-events-skills", "live-codemode-apps"].map(name => {
    const lines = readFileSync(join(evidence, name + ".stdout.txt"), "utf8").trim().split("\n");
    const summary = JSON.parse(lines.at(-1));
    if (!summary.passed) throw new Error(`${name} did not prove acceptance`);
    return summary;
  });
  const conformanceOutput = readFileSync(join(evidence, "official-conformance.stdout.txt"), "utf8");
  manifest.conformanceSummary = {
    passedScenarios: (conformanceOutput.match(/PASS$/gm) ?? []).length,
    expectedFailureScenarios: (conformanceOutput.match(/EXPECTED FAILURE/g) ?? []).length,
  };
  manifest.sourceUnchanged = sourceDigest() === manifest.sourceSha256;
  if (!manifest.sourceUnchanged) throw new Error("Source changed during verification; freeze and rerun");
  const artifactDirectory = resolve(root, "..", "artifacts", runId);
  mkdirSync(artifactDirectory, { recursive: true });
  run("package-checkpoint", ["pm", "pack", "--destination", artifactDirectory, "--quiet"]);
  const sourceArchive = join(artifactDirectory, "pi-mcp-complete-source.tgz");
  const archived = spawnSync("tar", ["-czf", sourceArchive, ...[...ignored, "VERIFICATION.json", "*.tgz", "*.log"].map(name => `--exclude=${name}`), "."],
    { cwd: root, encoding: "utf8", timeout: 60000 });
  if (archived.status !== 0 || archived.error) throw new Error("Source checkpoint archive failed");
  manifest.artifacts = readdirSync(artifactDirectory).filter(name => name.endsWith(".tgz")).map(name => {
    const path = join(artifactDirectory, name), bytes = readFileSync(path);
    return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  if (manifest.artifacts.reduce((bytes, entry) => bytes + entry.bytes, 0) > manifest.diskBudget.maximumArchiveBytes)
    throw new Error("Retained checkpoints exceed the 256 MiB per-run archive budget");
  if (sourceDigest() !== manifest.sourceSha256) throw new Error("Source changed while checkpointing");
  // Successful checks include a completed review, not acceptance of its findings.
  // The coordinator must adjudicate that report before certifying completion.
  manifest.status = "checks-passed-awaiting-review-adjudication";
} catch (error) {
  manifest.status = "failed";
  manifest.error = String(error);
  process.exitCode = 1;
} finally { manifest.finishedAt = new Date().toISOString(); save(); }
console.log(JSON.stringify(manifest, null, 2));
