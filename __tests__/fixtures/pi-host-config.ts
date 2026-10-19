import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { McpConfig } from "../../types.ts";

export const skillUri = "fixture://skills/host-proof/SKILL.md";
export const skillText = "---\nname: host-proof\ndescription: A verified skill for the real Pi host test.\n---\nUse the operator-approved MCP tools to inspect fixture evidence.\n";
export const hostConfig: McpConfig = {
  mcpServers: {
    complete: {
      command: process.execPath,
      args: ["--import", createRequire(import.meta.url).resolve("tsx"), fileURLToPath(import.meta.url), "--serve"],
      protocolVersion: "2026-07-28",
      tasks: true,
      lifecycle: "eager",
    },
  },
  settings: { directTools: false, autoAuth: false },
};

// Extend the existing real stdio fixture without changing its protocol tests.
if (process.argv.includes("--serve")) {
  const base = spawn(process.execPath, [fileURLToPath(new URL("./complete-server.mjs", import.meta.url)), "stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  const requests = new Map<string | number, string>();
  const streams = new Set<string | number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const skill = {
    uri: skillUri,
    frontmatter: { name: "host-proof", description: "A verified skill for the real Pi host test." },
    resources: [{ uri: skillUri, digest: "sha256:" + createHash("sha256").update(skillText).digest("hex"), size: Buffer.byteLength(skillText) }],
  };
  const send = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n");
  const triggerPath = process.argv.find(arg => arg.startsWith("--idle-trigger="))?.slice("--idle-trigger=".length);
  let delivered = false;
  const triggerTimer = triggerPath ? setInterval(() => {
    if (delivered || !existsSync(triggerPath) || streams.size === 0) return;
    delivered = true;
    for (const id of streams) send({ jsonrpc: "2.0", method: "notifications/events/event", params: {
      name: "tick", eventId: "gemini-idle-proof", timestamp: new Date().toISOString(), cursor: "live-1",
      data: { instruction: "Reply exactly GEMINI_EVENT_AWAKE to acknowledge this event." },
      _meta: { "io.modelcontextprotocol/subscriptionId": id },
    } });
  }, 100) : undefined;
  const complete = (body: object) => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...body });
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", line => {
    const request = JSON.parse(line);
    requests.set(request.id, request.method);
    const reply = (body: object) => send({ jsonrpc: "2.0", id: request.id, result: complete(body) });
    if (request.method === "skills/list") return reply({ skills: [skill] });
    if (request.method === "skills/get") return reply({ skill });
    if (request.method === "resources/read" && request.params.uri === skillUri)
      return reply({ contents: [{ uri: skillUri, mimeType: "text/markdown", text: skillText }] });
    if (request.method === "events/stream") streams.add(request.id);
    if (request.method === "notifications/cancelled") streams.delete(request.params.requestId);
    if (request.method === "tools/call" && request.params.name === "arm_idle_event") {
      reply({ content: [{ type: "text", text: "idle event armed" }] });
      const timer = setTimeout(() => {
        timers.delete(timer);
        for (const id of streams) send({ jsonrpc: "2.0", method: "notifications/events/event", params: {
          name: "tick", eventId: "idle-pi-host-event", timestamp: new Date().toISOString(), cursor: "idle-1",
          data: { proof: "real stdio event woke the actual Pi host" },
          _meta: { "io.modelcontextprotocol/subscriptionId": id },
        } });
      }, 1500);
      timers.add(timer);
      return;
    }
    base.stdin.write(line + "\n");
  });
  readline.createInterface({ input: base.stdout }).on("line", line => {
    const frame = JSON.parse(line);
    const method = requests.get(frame.id);
    if (method === "server/discover" && frame.result) {
      frame.result.capabilities.extensions["io.modelcontextprotocol/skills"] = {};
    }
    if (method === "tools/list" && frame.result) frame.result.tools.push({ name: "arm_idle_event", inputSchema: { type: "object", properties: {} } });
    if (frame.id !== undefined) requests.delete(frame.id);
    send(frame);
  });
  const close = () => { if (triggerTimer) clearInterval(triggerTimer); for (const timer of timers) clearTimeout(timer); base.kill(); };
  input.on("close", close);
  process.on("SIGTERM", () => { close(); process.exit(0); });
  base.on("exit", code => process.exit(code ?? 0));
}
