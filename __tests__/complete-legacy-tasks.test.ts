import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { callToolViaTaskSession, serverAdvertisesTasks } from "../mcp-tasks.ts";
import { CoreClient, CORE_PROTOCOL } from "../mcp-core.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { toolDeclarationFromMcpTool } from "@modelcontextprotocol/ext-tasks/client";
import { ToolSchema } from "@modelcontextprotocol/core";

const fixture = fileURLToPath(new URL("./fixtures/core-legacy-tasks-server.mjs", import.meta.url));
async function start(mode: "stdio" | "http", modern = false) {
  const manager = new McpServerManager(process.cwd()), owner = new AbortController();
  const args = [fixture, mode, ...(modern ? ["loops"] : [])];
  const child = mode === "http" ? spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] }) : undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    let endpoint: { command: string; args: string[] } | { url: string; auth: false };
    if (child) {
      const lines = readline.createInterface({ input: child.stdout });
      try {
        const line = await Promise.race([
          once(lines, "line").then(([line]) => String(line)),
          once(child, "exit").then(([code]) => { throw new Error(`Fixture exited: ${code}`); }),
          new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Fixture startup timeout")), 5000); }),
        ]);
        endpoint = { url: JSON.parse(line).url, auth: false };
      } finally { clearTimeout(startupTimer); lines.close(); }
    } else endpoint = { command: process.execPath, args };
    const connection = await manager.connect("legacy-tasks", { ...endpoint, protocolVersion: modern ? "2026-07-28" : "auto", tasks: true });
    return { connection, owner,
      core: new CoreClient(createProtocolSession(connection, owner.signal, CORE_PROTOCOL)),
      async inspect() {
        const result = await connection.client.callTool({ name: "inspect", arguments: {} });
        return JSON.parse((result.content[0] as { text: string }).text) as { log: Array<{ method: string; params?: any; id: string | number }> };
      },
      async close() {
        owner.abort(); await manager.closeAll();
        if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
      },
    };
  } catch (error) { owner.abort(); await manager.closeAll(); child?.kill(); throw error; }
}

for (const mode of ["stdio", "http"] as const) describe(`legacy Tasks via official SDK over ${mode}`, () => {
  it("uses live taskSupport metadata and preserves plain output validation", async () => {
    const f = await start(mode);
    try {
      const { connection } = f, session = connection.taskSession!;
      expect(serverAdvertisesTasks(connection.client)).toBe(true);
      expect(connection.client.getProtocolEra()).toBe("legacy");
      expect(session.capabilities).toMatchObject({ execution: true, inventory: "server-list", cancellation: true, inputResponses: false });
      for (const name of ["optional", "required"])
        expect(await callToolViaTaskSession(session, { name, args: {} })).toMatchObject({ content: [{ text: "legacy task done" }] });
      for (const name of ["plain", "forbidden"])
        expect(await callToolViaTaskSession(session, { name, args: {} })).toMatchObject({ content: [{ text: "ordinary" }] });
      const onprogress = vi.fn();
      expect(await callToolViaTaskSession(session, { name: "plain", args: {}, requestOptions: { onprogress } })).toMatchObject({ content: [{ text: "ordinary" }] });
      expect(onprogress).toHaveBeenCalledWith(expect.objectContaining({ progress: 1, message: "ordinary legacy progress" }));
      await expect(callToolViaTaskSession(session, { name: "invalid", args: {} })).rejects.toThrow();
      // A refreshed declaration is read from connection.tools on the next call.
      connection.tools = connection.tools.map(tool => tool.name === "optional" ? { ...tool, execution: { taskSupport: "forbidden" } } : tool);
      expect(await callToolViaTaskSession(session, { name: "optional", args: {} })).toMatchObject({ content: [{ text: "ordinary" }] });
      const { log } = await f.inspect();
      const calls = log.filter(row => row.method === "tools/call");
      expect(calls.find(row => row.params.name === "required")?.params.task).toEqual({});
      expect(calls.filter(row => row.params.name === "optional").map(row => row.params.task)).toEqual([{}, undefined]);
      expect(calls.find(row => row.params.name === "plain")?.params.task).toBeUndefined();
      expect(log.filter(row => row.method.startsWith("tasks/")).every(row => typeof row.id === "number")).toBe(true);
    } finally { await f.close(); }
  }, 15000);

  it("supports mediated get/list/result/cancel, pagination, and remote cancellation", async () => {
    const f = await start(mode);
    try {
      const session = f.connection.taskSession!;
      const declaration = toolDeclarationFromMcpTool(ToolSchema.parse(f.connection.tools.find(tool => tool.name === "optional")));
      const execution = await session.callTool("optional", {}, { declaration, task: { preference: "prefer" } });
      if (execution.kind !== "task") throw new Error("Expected legacy task");
      await execution.detach();
      const taskId = execution.handle.taskId;
      expect(await f.core.execute("tasks/get", { taskId })).toMatchObject({ taskId });
      expect(await f.core.execute("tasks/result", { taskId })).toMatchObject({ status: "completed", result: { content: [{ text: "legacy task done" }] } });
      const abort = new AbortController();
      const pending = callToolViaTaskSession(session, { name: "pending", args: {}, signal: abort.signal });
      const rejected = expect(pending).rejects.toThrow();
      await expect.poll(async () => (await f.inspect()).log.some(row => row.method === "tasks/get" && row.params.taskId === "legacy-2")).toBe(true);
      expect(await f.core.execute("tasks/list")).toMatchObject({ tasks: [{ taskId }, { taskId: "legacy-2" }] });
      await f.core.execute("tasks/cancel", { taskId: "legacy-2" });
      abort.abort(); await rejected;
      expect(await f.core.execute("tasks/get", { taskId: "legacy-2" })).toMatchObject({ status: "cancelled" });
      expect(await f.core.execute("tasks/result", { taskId: "legacy-2" })).toMatchObject({ status: "cancelled" });
      await expect(f.core.execute("tasks/update", { taskId, inputResponses: {} })).rejects.toThrow("unsupported");
      expect(f.connection.activeProtocolOperations).toBe(0);
    } finally { await f.close(); }
  }, 15000);

  it("accepts twelve valid modern input-required rounds on SDK 0.2.2", async () => {
    const f = await start(mode, true);
    try {
      expect(await callToolViaTaskSession(f.connection.taskSession!, { name: "loops", args: {} })).toMatchObject({ content: [{ text: "12 valid input rounds completed" }] });
    } finally { await f.close(); }
  }, 15000);
});
