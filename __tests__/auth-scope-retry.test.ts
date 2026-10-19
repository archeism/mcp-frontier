import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(repeated = false) {
  let authorized = false;
  const calls: Array<{ id: unknown; params: unknown }> = [];
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(message.method);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    response.setHeader("content-type", "application/json");
    let result;
    switch (message.method) {
      case "initialize": result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "scope-fixture", version: "1" } }; break;
      case "tools/list": result = { tools: [{ name: "test", inputSchema: { type: "object" } }] }; break;
      case "tools/call":
        calls.push({ id: message.id, params: message.params });
        if (!authorized || repeated) {
          response.setHeader("www-authenticate", 'Bearer error="insufficient_scope", scope="write"');
          response.writeHead(403).end("insufficient scope");
          return;
        }
        result = { content: [{ type: "text", text: "done" }] }; break;
      default:
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
        return;
    }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listen address");
  const manager = new McpServerManager();
  cleanup.push(() => manager.closeAll());
  const definition = { url: `http://127.0.0.1:${address.port}/mcp`, oauth: false as const };
  const connection = await manager.connect("scope", definition);
  return { manager, connection, definition, calls, methods, authorize: () => { authorized = true; } };
}

it.each(["accept", "decline", "absent", "repeated"])("scope challenge %s keeps consent explicit and bounds the same-request retry", async mode => {
  const f = await fixture(mode === "repeated");
  const before = [...f.methods];
  const handler = vi.fn(async (name, definition, challenge, signal) => {
    expect(name).toBe("scope");
    expect(definition).toEqual(f.definition);
    expect(challenge).toBeInstanceOf(InsufficientScopeError);
    expect(challenge.requiredScope).toBe("write");
    expect(signal.aborted).toBe(false);
    if (mode === "decline") return false;
    f.authorize();
    return true;
  });
  if (mode !== "absent") f.manager.setScopeChallengeHandler(handler);
  const request = f.connection.client.callTool({ name: "test", arguments: { value: 7 } });
  if (mode === "accept") await expect(request).resolves.toMatchObject({ content: [{ text: "done" }] });
  else await expect(request).rejects.toBeInstanceOf(InsufficientScopeError);
  const sends = mode === "accept" || mode === "repeated" ? 2 : 1;
  expect(f.calls).toHaveLength(sends);
  if (sends === 2) expect(f.calls[1]).toEqual(f.calls[0]);
  expect(handler).toHaveBeenCalledTimes(mode === "absent" ? 0 : 1);
  // No reconnect, model request, or other RPC accompanies consent or decline.
  expect(f.methods.slice(before.length)).toEqual(Array(sends).fill("tools/call"));
});

it("request cancellation aborts pending consent and prevents the retry", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  f.manager.setScopeChallengeHandler(async (_name, _definition, _challenge, signal) => {
    receivedSignal = signal;
    controller.abort(new Error("cancelled consent"));
    return true;
  });
  await expect(f.connection.client.callTool({ name: "test", arguments: {} },
    f.manager.getRequestOptions("scope", controller.signal))).rejects.toThrow();
  expect(receivedSignal?.aborted).toBe(true);
  expect(f.calls).toHaveLength(1);
});

it.each(["connection", "runtime"])("%s shutdown aborts consent and prevents retry", async owner => {
  const f = await fixture();
  const runtime = new AbortController();
  f.manager.setRuntimeSignal(runtime.signal);
  let receivedSignal: AbortSignal | undefined;
  f.manager.setScopeChallengeHandler(async (_name, _definition, _challenge, signal) => {
    receivedSignal = signal;
    if (owner === "runtime") runtime.abort(new Error("runtime stopped"));
    else await f.connection.transport.close();
    return true;
  });
  await expect(f.connection.client.callTool({ name: "test", arguments: {} })).rejects.toThrow();
  expect(receivedSignal?.aborted).toBe(true);
  expect(f.calls).toHaveLength(1);
});
