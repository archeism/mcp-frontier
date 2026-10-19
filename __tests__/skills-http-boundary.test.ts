import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { createSkillsResourceReadPolicy, SkillsClient, SKILLS_PROTOCOL } from "../mcp-skills.ts";
import { cleanupMaterializedBinaryResources, transformMcpResourceContents } from "../tool-registrar.ts";

it("real HTTP accepts exactly 512 manifest files and retrieves/materializes exactly 16 MiB through Skills policy", async () => {
  // One 16 MiB aggregate, no cohort copies: ~22 MiB base64 on wire, bounded 10s runtime.
  const uri = "skill://boundary/demo/SKILL.md", binary = "skill://boundary/demo/data.bin";
  const text = "---\nname: demo\ndescription: Boundary\n---\n";
  const files = new Map<string, Buffer>([[uri, Buffer.from(text)], [binary, Buffer.alloc(16 * 1024 * 1024 - Buffer.byteLength(text) - 510, 0x61)]]);
  for (let i = 0; i < 510; i++) files.set(`skill://boundary/demo/${i}.txt`, Buffer.from("x"));
  const entry = { uri, frontmatter: { name: "demo", description: "Boundary" }, resources: [...files].map(([uri, bytes]) => ({
    uri, size: bytes.length, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  })) };
  const reads: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const q = JSON.parse(body); let result: unknown;
    switch (q.method) {
      case "server/discover": result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } } }; break;
      case "tools/list": result = { tools: [] }; break;
      case "resources/list": result = { resources: [] }; break;
      case "resources/templates/list": result = { resourceTemplates: [] }; break;
      case "skills/get": result = { skill: entry }; break;
      case "resources/read": {
        const requested = q.params.uri; reads.push(requested);
        const bytes = files.get(requested)!;
        result = { contents: [{ uri: requested, ...(requested === binary ? { mimeType: "application/octet-stream", blob: bytes.toString("base64") } : { text: bytes.toString("utf8") }) }] }; break;
      }
      default: res.writeHead(400).end(); return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: q.id,
      result: { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result as object } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const manager = new McpServerManager(), policy = createSkillsResourceReadPolicy(), scope = {}, owner = new AbortController();
  manager.setResourceReadPolicy(policy.readResource);
  try {
    const connection = await manager.connect("http-boundary", { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, auth: false,
      protocolVersion: "2026-07-28", tasks: false });
    const skills = new SkillsClient(createProtocolSession(connection, owner.signal, SKILLS_PROTOCOL), { server: "http-boundary", resourceReadPolicy: policy });
    expect(entry.resources).toHaveLength(512);
    expect(entry.resources.reduce((sum, file) => sum + file.size, 0)).toBe(16 * 1024 * 1024);
    expect(await skills.load(uri, async () => true)).toBe(text);
    // Generic public SDK read must share the held manifest and retain materialization provenance.
    const result = await connection.client.readResource({ uri: binary });
    const rendered = transformMcpResourceContents(result.contents, scope);
    const path = (rendered[0] as { text: string }).text.match(/Binary content saved to (.+)/)?.[1];
    expect(path).toBeDefined(); expect(path).toContain("mcp-skill");
    const saved = readFileSync(path!);
    expect(saved.length).toBe(files.get(binary)!.length);
    expect(createHash("sha256").update(saved).digest("hex")).toBe(entry.resources[1]!.digest.slice(7));
    let transferred = Buffer.byteLength(text) + saved.length;
    for (let i = 0; i < 510; i++) { expect(await skills.read(uri, `${i}.txt`)).toMatchObject({ text: "x" }); transferred++; }
    expect(transferred).toBe(16 * 1024 * 1024); expect(reads).toHaveLength(512);
  } finally { owner.abort(); cleanupMaterializedBinaryResources(scope); await manager.closeAll();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 15000);
