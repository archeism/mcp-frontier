import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, getCurrentTools } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { DurableWebhookInbox } from "../../mcp-events-inbox.ts";
import { createDurableFrontier } from "./frontier.ts";
import { startDurableFixture } from "./fixture.ts";

const context = () => withAbortSignal(AbortSignal.timeout(20000), BACKGROUND_CONTEXT);
async function entries(conversation: Conversation) {
  return (await conversation.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT)).items;
}
function responses(code: string) {
  return [fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")];
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "durable-frontier-test-"));
  const upstream = await startDurableFixture(), faux = fauxProvider({ provider: "frontier-test" });
  const models = createModels(); models.setProvider(faux.provider);
  const errors: unknown[] = [], declarations: string[][] = [];
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (model, transcript, options) => {
    declarations.push(getCurrentTools(transcript.messages).map(tool => tool.name));
    return stream(model, transcript, options);
  };
  // A controlled wire error, not a mock of the bridge or execution pipeline.
  // The upstream still supplies all discovery, tool values and task behavior.
  let requests = 0;
  const gateway = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks), frame = JSON.parse(body.toString()); requests++;
    const proxy = request(upstream.definition.url!, { method: incoming.method, headers: incoming.headers }, response => {
      if (frame.method === "tools/call" && frame.params.arguments?.error === true) {
        const parts: Buffer[] = []; response.on("data", chunk => parts.push(Buffer.from(chunk)));
        response.on("end", () => {
          const value = JSON.parse(Buffer.concat(parts).toString());
          value.result.isError = true;
          outgoing.writeHead(response.statusCode ?? 200, { "content-type": "application/json" }).end(JSON.stringify(value));
        });
      } else {
        outgoing.writeHead(response.statusCode ?? 200, response.headers); response.pipe(outgoing);
        outgoing.on("close", () => response.destroy());
      }
    });
    proxy.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    proxy.end(body);
  });
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address(); if (!address || typeof address === "string") throw new Error("Missing gateway address");
  const definition = { ...upstream.definition, url: `http://127.0.0.1:${address.port}/mcp` };
  const open = async () => {
    const bridge = await createDurableFrontier({ directory: join(root, "frontier"), servers: { fixture: definition }, onError: error => errors.push(error) });
    const registry = createRegistry(); registry.install(bridge.extension);
    const code = createCodemodeExtension({ sandbox: new CodemodeSandbox(), models: false }); registry.install(code);
    const env = new NodeExecutionEnv({ cwd: root });
    const harness = await Harness.open(await openNodeSqliteStorage(join(root, "durable.sqlite")), {
      models, registry, env: () => env, onReport: error => errors.push(error), settings: { retry: { maxRetries: 0 } },
    }, context());
    const agent = { model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, modelTools: [code.tools![0]!], thinkingLevel: "off" as const };
    const conversation = await harness.root(context(), { agent }); await bridge.attach(conversation, context());
    return { bridge, harness, conversation, agent,
      async close() { try { await harness.close(BACKGROUND_CONTEXT); } finally { await bridge.close(); await env.cleanup(BACKGROUND_CONTEXT); } } };
  };
  return { root, upstream, faux, errors, declarations, open, requests: () => requests,
    async close() { gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); await upstream.close(); await rm(root, { recursive: true, force: true }); } };
}

it("declares MCP effects unsafe to replay and rejects unknown-server/foreign-conversation calls before HTTP", async () => {
  const f = await fixture(), h = await f.open();
  try {
    expect(h.bridge.extension.tools?.map(tool => [tool.name, tool.replay])).toEqual([
      ["frontier_tools", "unsafe"], ["frontier_events", "unsafe"],
    ]);
    f.faux.setResponses(responses('try { await tools.frontier_tools({server:"unapproved",action:"list"}); } catch(e) { text(e.message); }'));
    const submission = await h.conversation.submit({ type: "input", content: "Run the script", requestId: "unknown-server" }, context());
    expect((await submission.wait(context())).status).toBe("done");
    expect(JSON.stringify(await entries(h.conversation))).toContain("Server is not operator-approved");
    expect(f.requests()).toBe(0); expect(f.upstream.wire).toEqual([]);
    const other = await h.harness.createConversation({ ownership: { kind: "ownerless" }, agent: h.agent }, context());
    f.faux.setResponses(responses('try { await tools.frontier_tools({server:"fixture",action:"list"}); } catch(e) { text(e.message); }'));
    expect((await (await other.submit({ type: "input", content: "Run the script" }, context())).wait(context())).status).toBe("done");
    expect(JSON.stringify(await entries(other))).toContain("MCP Frontier is not attached to this conversation");
    expect(f.requests()).toBe(0); expect(f.upstream.wire).toEqual([]);
    expect(f.declarations.every(names => JSON.stringify(names) === '["codemode"]')).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await h.close(); await f.close(); }
}, 15000);

it("actual nested Durable codemode receives complete immediate/task MCP envelopes and structured error results", async () => {
  const f = await fixture(), h = await f.open();
  try {
    f.faux.setResponses(responses(`
      const a=await tools.frontier_tools({server:"fixture",action:"call",name:"read_secret"});
      const b=await tools.frontier_tools({server:"fixture",action:"call",name:"task_read"});
      const e=await tools.frontier_tools({server:"fixture",action:"call",name:"read_secret",arguments:{error:true}});
      if (typeof a !== "object" || !Array.isArray(a.content) || a.structuredContent.nonce !== b.structuredContent.nonce ||
          e.isError !== true || e.structuredContent.value !== a.structuredContent.value) throw Error("MCP envelope lost");
      text({a,b,e});`));
    expect((await (await h.conversation.submit({ type: "input", content: "Run the script" }, context())).wait(context())).status).toBe("done");
    const toolResults = (await entries(h.conversation)).filter(entry => entry.kind === "pi.tool-result");
    const output = JSON.stringify(toolResults);
    expect(output).toContain(f.upstream.toolValue.nonce); expect(output).toContain(String(f.upstream.toolValue.value));
    expect(output).not.toContain("MCP envelope lost"); expect(output).toContain('isError');
    expect(f.upstream.calls.map(call => call.name)).toEqual(["read_secret", "task_read", "read_secret"]);
    expect(f.upstream.wire.some(row => row.method === "tasks/get")).toBe(true);
    expect(f.declarations.every(names => JSON.stringify(names) === '["codemode"]')).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await h.close(); await f.close(); }
}, 15000);

it("a completed event submission survives ACK failure and SQLite reopen without another provider run", async () => {
  const f = await fixture(); let h = await f.open();
  const acknowledge = DurableWebhookInbox.prototype.acknowledge;
  let ackAttempted = false;
  const fault = vi.spyOn(DurableWebhookInbox.prototype, "acknowledge").mockImplementation(async function(this: DurableWebhookInbox, scope, id) {
    if (!ackAttempted && this.directory.startsWith(f.root)) { ackAttempted = true; throw new Error("Injected ACK failure after done"); }
    return acknowledge.call(this, scope, id);
  });
  try {
    f.faux.setResponses(responses('text(await tools.frontier_events({action:"subscribe",server:"fixture",name:"update",delivery:"poll"}));'));
    expect((await (await h.conversation.submit({ type: "input", content: "Subscribe" }, context())).wait(context())).status).toBe("done");
    const state = JSON.parse(await readFile(join(f.root, "frontier/events/subscriptions.json"), "utf8")) as { entries: Array<{ id: string }> };
    const event = f.upstream.arm();
    f.faux.setResponses([fauxAssistantMessage("Event consumed.")]);
    // The real fixture advises a 1000ms poll interval; include scheduling/HTTP.
    await expect.poll(() => ackAttempted, { timeout: 5000 }).toBe(true);
    await expect.poll(() => f.errors.length).toBe(1);
    expect(String(f.errors[0])).toContain("Injected ACK failure after done");
    const conversationId = h.conversation.id, scope = `${conversationId}/${state.entries[0]!.id}`;
    const inbox = new DurableWebhookInbox(join(f.root, "frontier/events/inbox"));
    expect(await inbox.pending(scope)).toHaveLength(1);
    const requestId = "mcp-frontier:event:" + createHash("sha256").update(JSON.stringify([conversationId, state.entries[0]!.id, event.eventId])).digest("hex");
    const admitted = await h.conversation.submit({ type: "input", content: "ignored duplicate", requestId }, context());
    expect((await admitted.wait(context())).status).toBe("done");
    const before = (await entries(h.conversation)).map(entry => entry.id), providerCalls = f.faux.state.callCount;
    await h.close(); h = await f.open();
    expect(h.conversation.id).toBe(conversationId);
    const duplicate = await h.conversation.submit({ type: "input", content: "ignored duplicate", requestId }, context());
    expect(duplicate.id).toBe(admitted.id); expect((await duplicate.wait(context())).status).toBe("done");
    await h.bridge.flush();
    expect(await inbox.pending(scope)).toHaveLength(0);
    expect((await entries(h.conversation)).map(entry => entry.id)).toEqual(before);
    expect(f.faux.state.callCount).toBe(providerCalls); expect(f.errors).toHaveLength(1);
  } finally { fault.mockRestore(); await h.close(); await f.close(); }
}, 15000);
