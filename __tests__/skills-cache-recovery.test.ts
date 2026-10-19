import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { McpServerManager } from "../server-manager.ts";
import { createSkillsResourceReadPolicy, validateSkill } from "../mcp-skills.ts";

const MAIN = "skill://acme/demo/SKILL.md", GUIDE = "skill://acme/demo/references/guide.txt";
async function fixture() {
  const source = readFileSync(new URL("./fixtures/skills-server.mjs", import.meta.url), "utf8")
    .replace("ttlMs: 0", "ttlMs: 60000");
  const policy = createSkillsResourceReadPolicy(), manager = new McpServerManager();
  let deny = false;
  manager.setResourceReadPolicy((server, uri, read, signal) => policy.readResource(server, uri, async () => {
    const result = await read();
    if (deny) throw new Error("operator denied");
    return result;
  }, signal));
  const connection = await manager.connect("fixture", { command: process.execPath,
    args: ["--input-type=module", "-e", source], protocolVersion: "2026-07-28", tasks: false, lifecycle: "eager" });
  const client = connection.client;
  const control = (arguments_: Record<string, unknown>) => client.callTool({ name: "control", arguments: arguments_ });
  const approve = async () => {
    const result = await client.request({ method: "skills/get", params: { uri: MAIN } }, z.any());
    policy.hold("fixture", validateSkill(result.skill), () => {});
  };
  const reads = async () => {
    const result = await control({});
    return JSON.parse((result.content[0] as { text: string }).text).filter((q: { method: string }) => q.method === "resources/read").length;
  };
  return { client, manager, policy, control, approve, reads, deny: (value: boolean) => { deny = value; } };
}

describe("SDK resource cache recovery after policy rejection", () => {
  it("rejects the stale hit without retry, then refreshes after fresh approval and resumes caching", async () => {
    const f = await fixture();
    try {
      await f.client.readResource({ uri: GUIDE });
      await f.control({ change: true }); await f.approve();
      const before = await f.reads();
      await expect(f.client.readResource({ uri: GUIDE })).rejects.toThrow("integrity");
      expect(await f.reads()).toBe(before);
      await expect(f.client.readResource({ uri: GUIDE })).rejects.toThrow("revoked");
      expect(await f.reads()).toBe(before);
      await f.approve();
      expect((await f.client.readResource({ uri: GUIDE })).contents[0]).toMatchObject({ text: "changed guide\n" });
      expect(await f.reads()).toBe(before + 1);
      await f.client.readResource({ uri: GUIDE });
      expect(await f.reads()).toBe(before + 1);
    } finally { await f.manager.closeAll(); }
  });
  it("verifies refreshed bytes and keeps recovery pending if the server still tampers", async () => {
    const f = await fixture();
    try {
      await f.client.readResource({ uri: GUIDE }); await f.control({ change: true }); await f.approve();
      await expect(f.client.readResource({ uri: GUIDE })).rejects.toThrow("integrity");
      await f.approve(); await f.control({ mode: "tamper" });
      await expect(f.client.readResource({ uri: GUIDE })).rejects.toThrow("integrity");
      await f.control({ mode: "normal" }); await f.approve();
      expect((await f.manager.readResource("fixture", GUIDE)).contents[0]).toMatchObject({ text: "changed guide\n" });
    } finally { await f.manager.closeAll(); }
  });
  it("preserves composed operator policy on recovery", async () => {
    const f = await fixture();
    try {
      await f.client.readResource({ uri: GUIDE }); await f.control({ change: true }); await f.approve();
      await expect(f.client.readResource({ uri: GUIDE })).rejects.toThrow("integrity");
      await f.approve(); f.deny(true);
      await expect(f.client.readResource({ uri: GUIDE })).rejects.toThrow("operator denied");
      f.deny(false); await f.approve();
      expect((await f.client.readResource({ uri: GUIDE })).contents[0]).toMatchObject({ text: "changed guide\n" });
    } finally { await f.manager.closeAll(); }
  });
  it("recovers cached reads after rejection through generic resources/read", async () => {
    const f = await fixture();
    try {
      await f.client.readResource({ uri: GUIDE }); await f.control({ change: true }); await f.approve();
      await f.control({ mode: "tamper" });
      await expect(f.client.request({ method: "resources/read", params: { uri: GUIDE } }, z.any())).rejects.toThrow("integrity");
      await f.control({ mode: "normal" }); await f.approve();
      expect((await f.client.readResource({ uri: GUIDE })).contents[0]).toMatchObject({ text: "changed guide\n" });
    } finally { await f.manager.closeAll(); }
  });
  it("does not mistake a successful bypass for SDK cache repair", async () => {
    const f = await fixture();
    try {
      await f.client.readResource({ uri: GUIDE }); await f.control({ change: true }); await f.approve();
      await expect(f.client.readResource({ uri: GUIDE })).rejects.toThrow("integrity");
      await f.approve();
      await f.client.readResource({ uri: GUIDE }, { cacheMode: "bypass" });
      const before = await f.reads();
      expect((await f.client.readResource({ uri: GUIDE })).contents[0]).toMatchObject({ text: "changed guide\n" });
      expect(await f.reads()).toBe(before + 1);
    } finally { await f.manager.closeAll(); }
  });
});
