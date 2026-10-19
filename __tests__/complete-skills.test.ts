import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { SkillsClient, SKILLS_PROTOCOL, validateSkill, createSkillsResourceReadPolicy, type SkillsResourceReadPolicy } from "../mcp-skills.ts";
import type { McpProtocolSession } from "../runtime-protocol.ts";
const URI = "skill://acme/demo/SKILL.md";
describe("Skills Unicode URI identity", () => {
  const uri = "skill://acme/技能/SKILL.md";
  const supporting = "skill://acme/技能/references/指南.txt";
  const text = "---\nname: 技能\ndescription: Test\n---\n";
  const files = [{ uri, text }, { uri: supporting, text: "Unicode guide" }];
  const entry = { uri, frontmatter: { name: "技能", description: "Test" }, resources: files.map(file => ({
    uri: file.uri, size: Buffer.byteLength(file.text), digest: "sha256:" + createHash("sha256").update(file.text).digest("hex"),
  })) };
  function client() {
    const requests: string[] = [];
    const session: McpProtocolSession = {
      signal: new AbortController().signal, protocolVersion: "2026-07-28",
      serverCapabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } },
      async request(method, params) {
        const requested = String(params?.uri);
        requests.push(requested);
        if (method === "skills/get") return { ttlMs: null, cacheScope: "private", skill: entry };
        const file = files.find(file => file.uri === requested);
        if (!file) throw new Error("Wire identifier changed");
        return { ttlMs: null, cacheScope: "private", contents: [file] };
      },
      watchNotifications() { throw new Error("unused"); }, openStream() { throw new Error("unused"); }, close() {},
    };
    return { client: new SkillsClient(session), requests };
  }
  it("reads SKILL.md and Unicode supporting filenames using original manifest wire identifiers", async () => {
    const f = client();
    expect(await f.client.load(uri, async () => true)).toBe(text);
    expect(await f.client.read(uri, "SKILL.md")).toMatchObject({ uri, text });
    expect(await f.client.read(uri, "references/指南.txt")).toMatchObject({ uri: supporting, text: "Unicode guide" });
    expect(f.requests.slice(-2)).toEqual([uri, supporting]);
  });
  it("accepts encoded-equivalent metadata, activation and file identities", async () => {
    const f = client();
    expect((await f.client.get(new URL(uri).href)).uri).toBe(uri);
    await f.client.load(uri, async () => true);
    expect(await f.client.read(new URL(uri).href, new URL(supporting).href.toLowerCase()))
      .toMatchObject({ text: "Unicode guide" });
    expect(await f.client.directory(new URL(uri).href, "references")).toEqual([{ uri: supporting, name: "指南.txt" }]);
    expect(validateSkill({ ...entry, resources: entry.resources.map(r => ({ ...r, uri: new URL(r.uri).href })) }).uri).toBe(uri);
    expect(validateSkill({ ...entry, resources: entry.resources.map(r => ({ ...r, uri: new URL(r.uri).href.replace("SKILL", "%53KILL") })) }).uri).toBe(uri);
    expect(() => validateSkill({ ...entry, resources: [...entry.resources, { ...entry.resources[0], uri: new URL(uri).href }] })).toThrow();
  });
  it("rejects traversal and encoded separators before URL resolution", async () => {
    const f = client();
    await f.client.load(uri, async () => true);
    for (const path of ["../技能/SKILL.md", "%2e%2e/技能/SKILL.md", "references%2f指南.txt", "references%5c指南.txt", "references/./指南.txt"]) {
      await expect(f.client.read(uri, path)).rejects.toThrow();
      await expect(f.client.directory(uri, path)).rejects.toThrow();
    }
    for (const path of ["%2e%2e", "%2F", "%5c", "%00", "%zz"]) {
      expect(() => validateSkill({ ...entry, resources: [...entry.resources, { ...entry.resources[1], uri: `skill://acme/技能/${path}/x` }] })).toThrow();
    }
  });
  it("rejects traversal and encoded separators in get/load before any request or consent", async () => {
    const f = client();
    let approved = false;
    for (const path of ["../技能", "%2e%2e/技能", ".%2E/技能", "%2E/技能", "技能%2fextra", "技能%5Cextra", "技能\\extra"]) {
      const invalid = `skill://acme/${path}/SKILL.md`;
      await expect(f.client.get(invalid)).rejects.toThrow();
      await expect(f.client.load(invalid, async () => { approved = true; return true; })).rejects.toThrow();
    }
    expect(f.requests).toEqual([]);
    expect(approved).toBe(false);
  });
  it("preserves URL resolution for root-relative reads and absolute directories", async () => {
    const f = client();
    await f.client.load(uri, async () => true);
    expect(await f.client.read(uri, "/技能/SKILL.md")).toMatchObject({ uri, text });
    for (const path of ["/技能/references", "skill://acme/技能/references"]) {
      expect(await f.client.directory(uri, path)).toEqual([{ uri: supporting, name: "指南.txt" }]);
    }
    for (const path of ["/outside", "//evil/private", "skill://evil/private"]) {
      await expect(f.client.read(uri, path)).rejects.toThrow();
      await expect(f.client.directory(uri, path)).rejects.toThrow();
    }
  });
});
describe("Skills authority syntax equivalence", () => {
  function client(uri: string) {
    const session: McpProtocolSession = {
      signal: new AbortController().signal, protocolVersion: "2026-07-28",
      serverCapabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } },
      async request() { return { ttlMs: 0, cacheScope: "private", skill: { uri,
        frontmatter: { name: "demo", description: "Test" }, resources: "dynamic" } }; },
      watchNotifications() { throw new Error("unused"); }, openStream() { throw new Error("unused"); }, close() {},
    };
    return new SkillsClient(session);
  }
  it.each([
    ["skill://acme/demo/SKILL.md", "skill://%61cme/demo/SKILL.md"],
    ["skill://acme/demo/SKILL.md", "skill://ACME/demo/SKILL.md"],
    ["skill://demo/SKILL.md", "skill://%64emo/SKILL.md"],
    ["skill://%C3%B1/demo/SKILL.md", "skill://%c3%b1/demo/SKILL.md"],
  ])("compares RFC-equivalent authority syntax while preserving wire metadata (%s, %s)", async (uri, alias) => {
    expect((await client(uri).get(alias)).uri).toBe(uri);
  });
  it.each([
    ["skill://acme!/demo/SKILL.md", "skill://acme%21/demo/SKILL.md"],
    ["skill://acme/demo/SKILL.md", "skill://acme./demo/SKILL.md"],
    ["skill://%C3%91/demo/SKILL.md", "skill://%C3%B1/demo/SKILL.md"],
  ])("does not invent authority equivalence (%s, %s)", async (uri, other) => {
    await expect(client(uri).get(other)).rejects.toThrow("substituted");
  });
  it.each(["%2f", "%5C", "%00", "%2e%2e"])("rejects unsafe authority escapes (%s)", async authority => {
    await expect(client("skill://acme/demo/SKILL.md").get(`skill://${authority}/demo/SKILL.md`)).rejects.toThrow();
  });
});
async function fixture(policy?: SkillsResourceReadPolicy) {
  const manager = new McpServerManager(process.cwd());
  manager.setResourceReadPolicy(policy?.readResource);
  const owner = new AbortController();
  const connection = await manager.connect("origin-a", { command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/skills-server.mjs", import.meta.url))],
    protocolVersion: "2026-07-28", tasks: false });
  const session = createProtocolSession(connection, owner.signal, SKILLS_PROTOCOL);
  const client = new SkillsClient(session, policy ? { server: "origin-a", resourceReadPolicy: policy } : undefined);
  return { client, connection,
    control: (args: Record<string, unknown>) => connection.client.callTool({ name: "control", arguments: args }),
    close: async () => { owner.abort(); await manager.closeAll(); },
  };
}
describe("known Skills metadata verification without activation", () => {
  it.each(["list", "get"])("verifies listed static files discovered by %s without activating the skill", async method => {
    const f = await fixture(createSkillsResourceReadPolicy());
    try {
      if (method === "list") await f.client.list(); else await f.client.get(URI);
      await expect(f.client.read(URI, "references/guide.txt")).rejects.toThrow("not activated");
      await expect(f.client.directory(URI)).rejects.toThrow("not activated");
      expect(await f.connection.client.readResource({ uri: "skill://acme/demo/references/guide.txt" })).toMatchObject({ contents: [{ text: "verified guide\n" }] });
      await f.control({ mode: "tamper" });
      for (const uri of [URI, "skill://acme/demo/references/guide.txt"])
        await expect(f.connection.client.readResource({ uri })).rejects.toThrow("verification");
    } finally { await f.close(); }
  });
  it("verifies frontmatter on generic reads of a known, unactivated SKILL.md", async () => {
    const f = await fixture(createSkillsResourceReadPolicy());
    try {
      await f.control({ mode: "frontmatter" }); await f.client.get(URI);
      await expect(f.connection.client.readResource({ uri: URI })).rejects.toThrow("frontmatter");
    } finally { await f.close(); }
  });
  it("refreshes metadata without conferring activation or restricting unknown ordinary files", async () => {
    const policy = createSkillsResourceReadPolicy(), f = await fixture(policy);
    try {
      await f.client.get(URI); await f.control({ change: true }); await f.client.get(URI);
      expect(await f.connection.client.readResource({ uri: "skill://acme/demo/references/guide.txt" })).toMatchObject({ contents: [{ text: "changed guide\n" }] });
      await expect(f.client.read(URI, "references/guide.txt")).rejects.toThrow("not activated");
      const ordinary = { ttlMs: 0, cacheScope: "private", contents: [{ uri: "skill://acme/demo/new.txt", text: "ordinary resource" }] };
      expect(await policy.readResource("origin-a", ordinary.contents[0]!.uri, async () => ordinary)).toEqual(ordinary);
    } finally { await f.close(); }
  });
  it("does not turn refreshed metadata into approval for a restored acting window", async () => {
    const policy = createSkillsResourceReadPolicy(), f = await fixture(policy);
    try {
      policy.restore("origin-a", URI); await f.client.get(URI);
      await expect(f.connection.client.readResource({ uri: URI })).rejects.toThrow("revoked");
      await f.client.load(URI, async () => true);
      expect(await f.client.read(URI, "SKILL.md")).toHaveProperty("text");
    } finally { await f.close(); }
  });
  it("does not clear an unknown-root legacy window after observing or activating one skill", async () => {
    const policy = createSkillsResourceReadPolicy(), f = await fixture(policy);
    try {
      policy.restore("origin-a"); await f.client.get(URI); await f.client.load(URI, async () => true);
      await expect(f.connection.client.readResource({ uri: URI })).rejects.toThrow("Restored skill approval");
      expect(await f.client.read(URI, "SKILL.md")).toHaveProperty("text");
    } finally { await f.close(); }
  });
  it.each([
    "skill://ACME/demo/%2fguide.txt",
    "skill://%61cme/%64emo/%5Cguide.txt",
    "skill://ACME/demo/%2e%2e/outside",
  ])("rejects unsafe alias paths at the shared policy boundary: %s", async uri => {
    const policy = createSkillsResourceReadPolicy(), f = await fixture(policy);
    try {
      await f.client.load(URI, async () => true);
      let fetched = false;
      await expect(policy.readResource("origin-a", uri, async () => {
        fetched = true; return { ttlMs: 0, cacheScope: "private", contents: [{ uri, text: "unverified" }] };
      })).rejects.toThrow();
      expect(fetched).toBe(false);
    } finally { await f.close(); }
  });
});
describe("final Skills extension over real SDK/stdio", () => {
  it("negotiates Skills, discovers metadata without fetching files, loads with consent and verifies relative reads", async () => {
    const f = await fixture();
    try {
      expect(await f.client.list()).toHaveLength(1);
      const wire = await f.control({});
      const rows = JSON.parse((wire.content[0] as { text: string }).text);
      expect(rows.some((r: any) => r.method === "resources/read")).toBe(false);
      expect(rows.find((r: any) => r.method === "skills/list").params._meta).toMatchObject({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/skills": {} } },
      });
      expect(await f.client.load(URI, async () => true)).toContain("name: demo");
      expect(await f.client.read(URI, "references/guide.txt")).toMatchObject({ text: "verified guide\n" });
      expect(await f.client.directory(URI)).toEqual([
        { uri: "skill://acme/demo/references", name: "references", mimeType: "inode/directory" },
        { uri: URI, name: "SKILL.md" },
      ]);
    } finally { await f.close(); }
  });
  it("loads directly by URI even when the server returns an empty list", async () => {
    const f = await fixture();
    try { await f.control({ mode: "empty" }); expect(await f.client.list()).toEqual([]); expect(await f.client.load(URI, async () => true)).toContain("name: demo"); }
    finally { await f.close(); }
  });
  it("does not fetch content after declined consent", async () => {
    const f = await fixture();
    try {
      await expect(f.client.load(URI, async () => false)).rejects.toThrow("declined");
      const wire = await f.control({});
      expect(JSON.parse((wire.content[0] as { text: string }).text).some((r: any) => r.method === "resources/read")).toBe(false);
    } finally { await f.close(); }
  });
  it("cannot resurrect an old activation after metadata changes during consent", async () => {
    const f = await fixture();
    try {
      let approve!: (value: boolean) => void, entered!: () => void;
      const pendingApproval = new Promise<boolean>(resolve => { approve = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const loading = f.client.load(URI, async () => { entered(); return pendingApproval; });
      const rejected = expect(loading).rejects.toThrow("changed while loading");
      await ready;
      await f.control({ change: true });
      await f.client.get(URI);
      approve(true);
      await rejected;
      await expect(f.client.read(URI, "references/guide.txt")).rejects.toThrow("revoked");
      await f.client.load(URI, async () => true);
      expect(await f.client.read(URI, "references/guide.txt")).toMatchObject({ text: "changed guide\n" });
    } finally { await f.close(); }
  });
  it("a delayed older metadata response cannot override a newer declined activation", async () => {
    const f = await fixture();
    try {
      let release!: () => void, entered!: () => void, first = true;
      const heldResponse = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const client = new SkillsClient({ ...f.client.session,
        request: async (method, params, signal) => {
          const result = await f.client.session.request(method, params, signal);
          if (method === "skills/get" && first) { first = false; entered(); await heldResponse; }
          return result;
        },
      });
      let staleConsentCalled = false;
      const older = client.load(URI, async () => { staleConsentCalled = true; return true; });
      const rejected = expect(older).rejects.toThrow("superseded");
      await ready;
      await expect(client.load(URI, async () => false)).rejects.toThrow("declined");
      release(); await rejected;
      expect(staleConsentCalled).toBe(false);
      await expect(client.read(URI, "references/guide.txt")).rejects.toThrow("revoked");
    } finally { await f.close(); }
  });
  for (const mode of ["tamper", "frontmatter", "dynamic", "substitute"]) it("rejects " + mode, async () => {
    const f = await fixture();
    try { await f.control({ mode }); await expect(f.client.load(URI, async () => true)).rejects.toThrow(); }
    finally { await f.close(); }
  });
  it("revokes approval on manifest changes and on corrupted file reads", async () => {
    const f = await fixture();
    try {
      await f.client.load(URI, async () => true);
      await f.control({ change: true });
      await f.client.get(URI);
      await expect(f.client.read(URI, "references/guide.txt")).rejects.toThrow("revoked");
      await f.client.load(URI, async () => true);
      await f.control({ mode: "tamper" });
      await expect(f.client.read(URI, "references/guide.txt")).rejects.toThrow("verification");
      await expect(f.client.read(URI, "references/guide.txt")).rejects.toThrow("revoked");
    } finally { await f.close(); }
  });
  it("supports explicitly approved dynamic Skills without reusing content approval", async () => {
    const f = await fixture();
    try {
      await f.control({ mode: "dynamic" });
      expect(await f.client.load(URI, async () => true, undefined, true)).toContain("name: demo");
      await expect(f.client.read(URI, "references/guide.txt")).rejects.toThrow("per-read");
      await expect(f.client.read(URI, "references/guide.txt", undefined, async () => false)).rejects.toThrow("per-read");
      expect(await f.client.read(URI, "references/guide.txt", undefined, async uri => {
        expect(uri).toBe("skill://acme/demo/references/guide.txt"); return true;
      })).toMatchObject({ text: "verified guide\n" });
      await expect(f.client.read(URI, "references/guide.txt")).rejects.toThrow("per-read");
      const children = await f.client.directory(URI) as { uri: string }[];
      expect(children.some(item => item.uri === "skill://acme/demo/new.txt")).toBe(true);
      expect(children.some(item => item.uri.includes("evil"))).toBe(false);
      await f.client.get(URI);
      await expect(f.client.read(URI, "references/guide.txt", undefined, async () => true)).rejects.toThrow("revoked");
    } finally { await f.close(); }
  });
  it("rejects traversal, unlisted files, cross-origin references and repeated pagination cursors", async () => {
    const f = await fixture();
    try {
      await f.client.load(URI, async () => true);
      for (const path of ["../private", "new.txt", "skill://evil/private.txt", "%2e%2e/private"])
        await expect(f.client.read(URI, path)).rejects.toThrow();
      await f.control({ mode: "cursor" });
      await expect(f.client.list()).rejects.toThrow("Repeated");
    } finally { await f.close(); }
  });
  it("requires capability advertisement and rejects operations after closure", async () => {
    const f = await fixture();
    try {
      const session = createProtocolSession(f.connection, new AbortController().signal, SKILLS_PROTOCOL);
      const missing = new SkillsClient({ ...session, serverCapabilities: {}, protocolVersion: "2026-07-28" });
      await expect(missing.list()).rejects.toThrow("declare");
      session.close();
      await expect(new SkillsClient(session).list()).rejects.toThrow("ended");
    } finally { await f.close(); }
  });
});
it("validates complete manifests, resource limits and URI/name identity", () => {
  const text = "---\nname: demo\ndescription: Test\n---\n";
  const valid = { uri: URI, frontmatter: { name: "demo", description: "Test" }, resources: [
    { uri: URI, size: Buffer.byteLength(text), digest: "sha256:" + createHash("sha256").update(text).digest("hex") },
  ] };
  expect(validateSkill(valid)).toMatchObject(valid);
  for (const bad of [
    { ...valid, resources: [] },
    { ...valid, frontmatter: { name: "wrong", description: "Test" } },
    { ...valid, resources: [...valid.resources, ...valid.resources] },
    { ...valid, resources: [{ ...valid.resources[0], size: 16777217 }] },
    { ...valid, resources: [{ ...valid.resources[0], uri: "skill://acme/demo/%2e%2e/private" }] },
    { ...valid, frontmatter: { ...valid.frontmatter, description: "a".repeat(1025) } },
    { ...valid, frontmatter: { ...valid.frontmatter, compatibility: "a".repeat(501) } },
  ]) expect(() => validateSkill(bad)).toThrow();
  const resources = Array.from({ length: 512 }, (_, index) => ({
    ...valid.resources[0]!, uri: index === 0 ? URI : `skill://acme/demo/${index}.txt`, size: 32768,
  }));
  expect(validateSkill({ ...valid, resources }).resources).toHaveLength(512);
  const unicode = "𐐨".repeat(64);
  const uri = `skill://acme/${unicode}/SKILL.md`;
  expect(validateSkill({ ...valid, uri, frontmatter: { name: unicode, description: "Test" },
    resources: [{ ...valid.resources[0]!, uri }] }).frontmatter.name).toBe(unicode);
});

