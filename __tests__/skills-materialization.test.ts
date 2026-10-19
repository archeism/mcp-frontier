import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillsResourceReadPolicy, validateSkill } from "../mcp-skills.ts";
import { cleanupMaterializedBinaryResources, transformMcpResourceContents } from "../tool-registrar.ts";

const MAIN = "skill://acme/demo/SKILL.md", FILE = "skill://acme/demo/data.bin";
const text = "---\nname: demo\ndescription: Test\n---\n";
const scopes: object[] = [];
afterEach(() => { for (const scope of scopes.splice(0)) cleanupMaterializedBinaryResources(scope); });

function fixture(server = "origin-a", bytes = Buffer.from("verified binary"), uri = FILE) {
  const policy = createSkillsResourceReadPolicy(), scope = {};
  scopes.push(scope);
  const entry = validateSkill({ uri: MAIN, frontmatter: { name: "demo", description: "Test" }, resources: [
    { uri: MAIN, size: Buffer.byteLength(text), digest: "sha256:" + createHash("sha256").update(text).digest("hex") },
    { uri, size: bytes.length, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") },
  ] });
  policy.hold(server, entry, () => {});
  const read = () => policy.readResource(server, uri, async () => ({ ttlMs: 0, cacheScope: "private",
    contents: [{ uri, mimeType: "application/octet-stream", blob: bytes.toString("base64") }],
  }));
  return { policy, scope, read, bytes, server, uri };
}
function output(contents: Parameters<typeof transformMcpResourceContents>[0], scope: object) {
  const blocks = transformMcpResourceContents(contents, scope);
  expect(blocks[0]?.type).toBe("text");
  return (blocks[0] as { text: string }).text;
}
function pathFrom(text: string) {
  const path = text.match(/Binary content saved to (.+)/)?.[1];
  expect(path).toBeDefined(); return path!;
}
function originFrom(path: string) {
  const segments = path.split(sep), marker = segments.lastIndexOf("mcp-skill");
  expect(marker).toBeGreaterThanOrEqual(0);
  return JSON.parse(Buffer.from(segments.slice(marker + 1, -1).join(""), "base64url").toString("utf8"));
}

describe("verified Skills binary materialization", () => {
  it("makes the originating server and resource URI recoverable from the materialized path", async () => {
    const f = fixture(), result = await f.read();
    const rendered = output(result.contents, f.scope), path = pathFrom(rendered);
    expect(originFrom(path)).toEqual({ server: f.server, uri: f.uri });
    expect(rendered).toContain("origin-a");
    expect(readFileSync(path)).toEqual(f.bytes);
  });
  it("keeps identical URIs from different servers in distinct reversible origin paths", async () => {
    const a = fixture("origin-a"), b = fixture("origin-b");
    const paths = await Promise.all([a, b].map(async f => pathFrom(output((await f.read()).contents, f.scope))));
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.map(originFrom)).toEqual([{ server: "origin-a", uri: FILE }, { server: "origin-b", uri: FILE }]);
  });
  it("supports long URIs without using an overlong filesystem component", async () => {
    const f = fixture("来源 / ../ a", undefined, "skill://acme/demo/" + "a".repeat(240) + ".bin");
    const path = pathFrom(output((await f.read()).contents, f.scope));
    expect(originFrom(path)).toEqual({ server: f.server, uri: f.uri });
    expect(readFileSync(path)).toEqual(f.bytes);
  });
  it("materializes a verified binary within a skill totaling exactly 16 MiB", async () => {
    const f = fixture("origin-a", Buffer.alloc(16 * 1024 * 1024 - Buffer.byteLength(text), 0x61));
    const path = pathFrom(output((await f.read()).contents, f.scope));
    const saved = readFileSync(path);
    expect(saved.length).toBe(f.bytes.length);
    expect(createHash("sha256").update(saved).digest("hex")).toBe(createHash("sha256").update(f.bytes).digest("hex"));
  });
  it("rejects bytes mutated after verification and before materialization", async () => {
    const f = fixture(), result = await f.read();
    result.contents[0]!.blob = Buffer.from("tampered bytes!").toString("base64");
    const rendered = output(result.contents, f.scope);
    expect(rendered).toContain("verification failed");
    expect(rendered).not.toContain("Binary content saved to");
  });
  it("does not serve a modified delivery artifact as the host resource cache", async () => {
    const f = fixture();
    const first = pathFrom(output((await f.read()).contents, f.scope));
    writeFileSync(first, "local edits");
    const second = pathFrom(output((await f.read()).contents, f.scope));
    expect(second).not.toBe(first);
    expect(readFileSync(second)).toEqual(f.bytes);
    expect(readFileSync(first, "utf8")).toBe("local edits");
    cleanupMaterializedBinaryResources(f.scope);
    expect(existsSync(first)).toBe(false); expect(existsSync(second)).toBe(false);
  });
  it("does not trust server-supplied metadata as verified Skills provenance", () => {
    const scope = {}; scopes.push(scope);
    const result = { uri: FILE, mimeType: "application/octet-stream", blob: Buffer.from("ordinary").toString("base64"),
      _meta: { "pi-mcp-adapter/skill-origin": { server: "forged", uri: FILE, digest: "sha256:" + "0".repeat(64) } } };
    const rendered = output([result], scope), path = pathFrom(rendered);
    expect(path.split(sep)).not.toContain("mcp-skill");
    expect(readFileSync(path, "utf8")).toBe("ordinary");
  });
});
