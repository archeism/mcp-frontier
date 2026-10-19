import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { cleanupMaterializedBinaryResources, resolveMcpResultContent, transformMcpResourceContents } from "../tool-registrar.ts";

it("preserves remote audio and binary bytes through the official SDK and Pi content adaptation", async () => {
  const require = createRequire(import.meta.url);
  const moduleUrl = (name: string) => pathToFileURL(require.resolve(name).replace(/\.cjs$/, ".mjs")).href;
  const data = Buffer.from([0, 255, 12, 34, 56, 0, 128]);
  const blob = data.toString("base64");
  const source = `
    import { Server } from ${JSON.stringify(moduleUrl("@modelcontextprotocol/server"))};
    import { StdioServerTransport } from ${JSON.stringify(moduleUrl("@modelcontextprotocol/server/stdio"))};
    const server = new Server({name:"content-proof",version:"1"}, {capabilities:{tools:{},resources:{}}});
    server.setRequestHandler("tools/list", async () => ({tools:[{name:"content",inputSchema:{type:"object"}}]}));
    server.setRequestHandler("resources/list", async () => ({resources:[]}));
    server.setRequestHandler("resources/read", async () => ({contents:[{uri:"fixture://binary",mimeType:"application/octet-stream",blob:${JSON.stringify(blob)}}]}));
    server.setRequestHandler("tools/call", async () => ({content:[
      {type:"text",text:"text proof"},
      {type:"image",data:${JSON.stringify(blob)},mimeType:"image/png"},
      {type:"audio",data:${JSON.stringify(blob)},mimeType:"audio/wav"},
      {type:"resource_link",uri:"fixture://linked",name:"linked",description:"untrusted reference"},
      {type:"resource",resource:{uri:"fixture://embedded",mimeType:"application/octet-stream",blob:${JSON.stringify(blob)}}}
    ],structuredContent:{preserved:true}}));
    await server.connect(new StdioServerTransport());
  `;
  const manager = new McpServerManager(process.cwd()), owner = new AbortController();
  try {
    const connection = await manager.connect("content", { command: process.execPath,
      args: ["--input-type=module", "--eval", source], tasks: false });
    const remote = await connection.client.callTool({ name: "content", arguments: {} });
    expect(remote.content[2]).toMatchObject({ type: "audio", data: blob, mimeType: "audio/wav" });
    const blocks = resolveMcpResultContent(remote, owner.signal);
    expect(blocks[0]).toEqual({ type: "text", text: "text proof" });
    expect(blocks[1]).toMatchObject({ type: "image", data: blob });
    expect(JSON.stringify(blocks)).toContain("fixture://linked");
    expect(JSON.stringify(blocks)).toContain("structuredContent");
    for (const index of [2, 4]) {
      const block = blocks[index]!;
      if (block.type !== "text") throw new Error("Expected materialized binary description");
      const path = block.text.match(/Binary content saved to (.+)/)?.[1];
      expect(path).toBeDefined();
      expect(readFileSync(path!)).toEqual(data);
      expect(statSync(path!).mode & 0o777).toBe(0o600);
    }
    const resource = await connection.client.readResource({ uri: "fixture://binary" });
    expect(resource.contents[0]).toMatchObject({ blob });
    const adapted = transformMcpResourceContents(resource.contents, owner.signal);
    const block = adapted[0]!;
    if (block.type !== "text") throw new Error("Expected binary file description");
    expect(readFileSync(block.text.match(/Binary content saved to (.+)/)![1]!)).toEqual(data);
  } finally { owner.abort(); cleanupMaterializedBinaryResources(owner.signal); await manager.closeAll(); }
});
