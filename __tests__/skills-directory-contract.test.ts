import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SkillsClient } from "../mcp-skills.ts";
import type { McpProtocolSession } from "../runtime-protocol.ts";

const URI = "skill://acme/demo/SKILL.md", GUIDE = "skill://acme/demo/guide.txt";
function fixture(uri = URI, dynamic = false) {
  const text = "---\nname: demo\ndescription: Test\n---\n";
  const guide = new URL("guide.txt", uri).href;
  const root = new URL(".", uri).href.replace(/\/$/, "");
  const files = [{ uri, text }, { uri: guide, text: "guide" }];
  let entry = { uri, frontmatter: { name: "demo", description: "Test" }, resources: dynamic ? "dynamic" as const : files.map(file => ({
    uri: file.uri, size: Buffer.byteLength(file.text), digest: "sha256:" + createHash("sha256").update(file.text).digest("hex"),
  })) };
  const child = { uri: guide, name: "guide.txt", title: "Guide", mimeType: "text/plain", description: "Supporting file", _meta: { fixture: true } };
  let directory = async (_params?: Record<string, unknown>): Promise<Record<string, unknown>> => ({ resources: [child] });
  const calls: Array<{ method: string; uri?: unknown }> = [];
  const owner = new AbortController();
  const session: McpProtocolSession = {
    signal: owner.signal, protocolVersion: "2026-07-28",
    serverCapabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } } },
    async request(method, params) {
      calls.push({ method, uri: params?.uri });
      const hints = { ttlMs: 0, cacheScope: "private" };
      if (method === "skills/get") return { ...hints, skill: entry };
      if (method === "resources/directory/read") {
        expect(params?.uri).toBe(root);
        return { ...hints, ...await directory(params) };
      }
      const file = files.find(file => file.uri === params?.uri);
      if (!file) throw new Error("Unexpected wire URI: " + params?.uri);
      return { ...hints, contents: [file] };
    },
    watchNotifications() { throw new Error("unused"); }, openStream() { throw new Error("unused"); }, close() { owner.abort(); },
  };
  return { client: new SkillsClient(session), child, guide, root, calls,
    directory: (next: typeof directory) => { directory = next; },
    change: () => { entry = { ...entry, resources: "dynamic" }; },
  };
}

describe("escaped SKILL.md path segments", () => {
  it("resolves dynamic supporting files from the parent of an escaped SKILL.md segment", async () => {
    const uri = "skill://acme/demo/%53KILL.md", f = fixture(uri, true);
    await f.client.load(uri, async () => true, undefined, true);
    expect(await f.client.read(uri, "guide.txt", undefined, async () => true)).toMatchObject({ uri: GUIDE, text: "guide" });
  });
  it("resolves a live directory from the parent of an escaped SKILL.md segment", async () => {
    const uri = "skill://acme/demo/%53KILL.md", f = fixture(uri);
    await f.client.load(uri, async () => true);
    expect(await f.client.directory(uri)).toEqual([f.child]);
  });
});

describe("Skills directory Resource contract", () => {
  it.each([
    { uri: GUIDE }, { uri: GUIDE, name: "guide", mimeType: 42 },
    { uri: GUIDE, name: 42 }, { uri: GUIDE, name: "guide", description: false },
  ])("rejects malformed Resource metadata: %j", async child => {
    const f = fixture(); await f.client.load(URI, async () => true);
    f.directory(async () => ({ resources: [child] }));
    await expect(f.client.directory(URI)).rejects.toThrow();
  });
  it("preserves complete valid Resource metadata", async () => {
    const f = fixture(); await f.client.load(URI, async () => true);
    expect(await f.client.directory(URI)).toEqual([f.child]);
  });
  it.each([false, true])("rejects a directory response after metadata revocation (paginated=%s)", async paginated => {
    const f = fixture(); await f.client.load(URI, async () => true);
    let release!: () => void, entered!: () => void;
    const heldResponse = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.directory(async params => {
      if (paginated && !params?.cursor) return { resources: [f.child], nextCursor: "second" };
      entered(); await heldResponse; return { resources: [f.child] };
    });
    const reading = f.client.directory(URI);
    const rejected = expect(reading).rejects.toThrow("revoked");
    await ready; f.change(); await f.client.get(URI); release(); await rejected;
  });
});
