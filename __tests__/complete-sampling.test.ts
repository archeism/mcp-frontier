import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { CreateMessageResultWithToolsSchema, CreateTaskResultSchema } from "@modelcontextprotocol/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import type { CreateMessageRequest } from "@modelcontextprotocol/client";
import { handleSamplingRequest, registerSamplingHandler, registerSamplingTaskReceiver, type SamplingHandlerOptions } from "../sampling-handler.ts";

const usage: AssistantMessage["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model: Model<Api> = { api: "anthropic-messages", provider: "anthropic", id: "test", name: "test", baseUrl: "https://example.invalid", reasoning: false, input: ["text", "image"], contextWindow: 10000, maxTokens: 1000, cost: usage.cost };
const answer: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "done" }], usage, stopReason: "stop", timestamp: 1 };
const tool = { name: "lookup", description: "Look up an item", inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] } };
const complete = vi.fn<(model: Model<Api>, context: Context, options?: ProviderStreamOptions) => Promise<AssistantMessage>>();
const options = (overrides: Partial<SamplingHandlerOptions> = {}): SamplingHandlerOptions => ({ serverName: "test-server", autoApprove: true, modelRegistry: { getAvailable: () => [model], complete }, getCurrentModel: () => model, getSignal: () => undefined, ...overrides });
const request = (params: Partial<CreateMessageRequest["params"]> = {}): CreateMessageRequest => ({ method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "hello" } }], maxTokens: 100, ...params } });

describe("complete sampling", () => {
  beforeEach(() => { complete.mockReset().mockResolvedValue(answer); });

  it("shows complete request tails, authorized context and untrusted tool history before provider execution", async () => {
    const tail = "prefix ".repeat(100) + "REQUEST_TAIL";
    const confirm = vi.fn(async (_title: string, body: string) => {
      if (confirm.mock.calls.length === 1) {
        expect(complete).not.toHaveBeenCalled();
        expect(body).toContain(tail); expect(body).toContain("CONTEXT_TAIL");
        expect(body).toContain("untrusted server-supplied history");
        expect(body).toContain("not proof of Pi tool execution");
        expect(body).toContain("prior-call"); expect(body).toContain("lookup");
      }
      return true;
    });
    await handleSamplingRequest(options({ autoApprove: false, ui: { confirm }, getContext: () => [{ role: "user", content: tail + "CONTEXT_TAIL", timestamp: 1 }] }), request({
      systemPrompt: tail, includeContext: "thisServer", tools: [tool], messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "prior-call", name: "lookup", input: { id: tail } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "prior-call", content: [{ type: "text", text: tail }] }] },
      ],
    }));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("shows complete generated response and tool arguments before response approval", async () => {
    const tail = "response ".repeat(200) + "RESPONSE_TAIL";
    complete.mockResolvedValue({ ...answer, content: [{ type: "text", text: tail }, { type: "toolCall", id: "next", name: "lookup", arguments: { id: tail } }] });
    const confirm = vi.fn(async (title: string, body: string) => {
      if (title === "Return MCP sampling response") { expect(body).toContain(tail); expect(body).toContain(JSON.stringify({ id: tail })); return false; }
      return true;
    });
    await expect(handleSamplingRequest(options({ autoApprove: false, ui: { confirm } }), request({ tools: [tool] }))).rejects.toThrow("declined");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("offers explicit prompt editing through existing Pi UI and confirms the edited payload", async () => {
    const select = vi.fn().mockResolvedValueOnce("Edit prompt").mockResolvedValueOnce("System prompt").mockResolvedValueOnce("Continue");
    const editor = vi.fn(async (_title: string, prefill?: string) => { expect(prefill).toBe("original"); return "edited prompt"; });
    const confirm = vi.fn(async (_title: string, body: string) => { if (confirm.mock.calls.length === 1) expect(body).toContain("System: edited prompt"); return true; });
    const original = request({ systemPrompt: "original" }); Object.freeze(original.params);
    await handleSamplingRequest(options({ autoApprove: false, ui: { confirm, select, editor } }), original);
    expect(select.mock.calls[0][1]).toContain("Edit prompt");
    expect(editor).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[1].systemPrompt).toBe("edited prompt");
    expect(original.params.systemPrompt).toBe("original");
  });

  it("edits authorized text and tool arguments without changing source context or exposing image bytes", async () => {
    const context: Context["messages"] = [{ role: "user", content: [{ type: "text", text: "private authorized text" }, { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BASE64" }], timestamp: 1 }];
    const select = vi.fn().mockResolvedValueOnce("Edit prompt").mockResolvedValueOnce("Message 1 (user) text 1")
      .mockResolvedValueOnce("Edit prompt").mockResolvedValueOnce("Message 2 tool lookup arguments 1").mockResolvedValueOnce("Continue");
    const editor = vi.fn().mockResolvedValueOnce("edited authorized text").mockResolvedValueOnce('{"id":"edited-args"}');
    const confirm = vi.fn(async (_title: string, body: string) => {
      expect(body).not.toContain("PRIVATE_IMAGE_BASE64");
      if (confirm.mock.calls.length === 1) { expect(body).toContain("edited authorized text"); expect(body).toContain("edited-args"); expect(body).toContain("binary pixels are not displayed"); }
      return true;
    });
    const original = request({ includeContext: "thisServer", tools: [tool], messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "prior", name: "lookup", input: { id: "original" } }] },
    ] });
    const before = JSON.stringify({ context, original });
    await handleSamplingRequest(options({ autoApprove: false, ui: { confirm, select, editor }, getContext: () => context }), original);
    expect(JSON.stringify({ context, original })).toBe(before);
    expect(complete.mock.calls[0]?.[1].messages).toMatchObject([
      { content: [{ text: "edited authorized text" }, { data: "PRIVATE_IMAGE_BASE64" }] },
      { content: [{ arguments: { id: "edited-args" } }] },
    ]);
  });

  it("keeps explicit auto-approval unchanged and never opens an editor", async () => {
    const ui = { confirm: vi.fn(), select: vi.fn(), editor: vi.fn() };
    await handleSamplingRequest(options({ autoApprove: true, ui }), request());
    expect(ui.confirm).not.toHaveBeenCalled(); expect(ui.select).not.toHaveBeenCalled(); expect(ui.editor).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "abort"])("fails closed on editor %s before provider execution", async mode => {
    const controller = new AbortController();
    const ui = { confirm: vi.fn(), select: vi.fn().mockResolvedValueOnce("Edit prompt").mockResolvedValueOnce("System prompt"),
      editor: vi.fn(async () => { if (mode === "abort") { controller.abort(new Error("editor aborted")); return new Promise<string>(() => {}); } return undefined; }) };
    await expect(handleSamplingRequest(options({ autoApprove: false, ui }), request(), controller.signal)).rejects.toThrow(mode === "abort" ? "editor aborted" : "declined");
    expect(complete).not.toHaveBeenCalled(); expect(ui.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["anthropic-messages", "any"], ["google-generative-ai", "any"], ["google-vertex", "any"],
    ["bedrock-converse-stream", "any"], ["openai-completions", "required"], ["openai-responses", "required"],
    ["azure-openai-responses", "required"], ["openai-codex-responses", "required"], ["mistral-conversations", "required"], ["pi-messages", "required"],
  ])("maps tools and required tool choice for %s", async (api, choice) => {
    await handleSamplingRequest(options({ getCurrentModel: () => ({ ...model, api }) }), request({ tools: [tool], toolChoice: { mode: "required" }, temperature: 0, metadata: { user_id: "u" } }));
    expect(complete.mock.calls[0]?.[1].tools).toEqual([{ name: tool.name, description: tool.description, parameters: tool.inputSchema }]);
    expect(complete.mock.calls[0]?.[2]).toMatchObject({ toolChoice: choice, maxTokens: 100, temperature: 0, metadata: { user_id: "u" } });
  });

  it.each(["auto", "none"] as const)("preserves %s tool choice", async mode => {
    await handleSamplingRequest(options(), request({ tools: [tool], toolChoice: { mode } }));
    expect(complete.mock.calls[0]?.[2]?.toolChoice).toBe(mode);
  });

  it.each([
    ["anthropic-messages", { max_tokens: 100 }, { max_tokens: 100, stop_sequences: ["END"] }],
    ["google-generative-ai", { config: { temperature: 0 } }, { config: { temperature: 0, stopSequences: ["END"] } }],
    ["google-vertex", { config: { maxOutputTokens: 100 } }, { config: { maxOutputTokens: 100, stopSequences: ["END"] } }],
    ["bedrock-converse-stream", { inferenceConfig: { maxTokens: 100 } }, { inferenceConfig: { maxTokens: 100, stopSequences: ["END"] } }],
    ["openai-completions", { temperature: 0 }, { temperature: 0, stop: ["END"] }],
    ["mistral-conversations", { temperature: 0 }, { temperature: 0, stop: ["END"] }],
  ])("applies stop sequences to the %s provider payload", async (api, payload, expected) => {
    await handleSamplingRequest(options({ getCurrentModel: () => ({ ...model, api }) }), request({ stopSequences: ["END"] }));
    const onPayload = complete.mock.calls[0]?.[2]?.onPayload;
    expect(onPayload).toBeTypeOf("function");
    expect(await onPayload?.(payload, model)).toEqual(expected);
    expect(payload).not.toEqual(expected);
  });

  it("fails before completion when provider options cannot be honored", async () => {
    await expect(handleSamplingRequest(options({ getCurrentModel: () => ({ ...model, api: "openai-responses" }) }), request({ stopSequences: ["END"] }))).rejects.toThrow("stop sequences are not supported");
    await expect(handleSamplingRequest(options(), request({ toolChoice: { mode: "required" } }))).rejects.toThrow("requires tools");
    expect(complete).not.toHaveBeenCalled();
  });

  it("converts user images and tool exchanges, including structured results", async () => {
    await handleSamplingRequest(options(), request({ messages: [
      { role: "user", content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } },
      { role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "tool_use", id: "call1", name: "lookup", input: { id: "42" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call1", content: [{ type: "text", text: "missing" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], structuredContent: { found: false }, isError: true }, { type: "text", text: "Try again" }] },
    ] }));
    expect(complete.mock.calls[0]?.[1].messages).toMatchObject([
      { role: "user", content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "toolCall", id: "call1", name: "lookup", arguments: { id: "42" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "call1", toolName: "lookup", isError: true, content: [{ type: "text", text: "missing" }, { type: "image" }, { type: "text", text: '{"found":false}' }] },
      { role: "user", content: [{ type: "text", text: "Try again" }] },
    ]);
  });

  it("returns SDK-valid tool-use results without exposing thinking", async () => {
    complete.mockResolvedValue({ ...answer, stopReason: "toolUse", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Checking" }, { type: "toolCall", id: "c1", name: "lookup", arguments: { id: "42" } }] });
    const result = await handleSamplingRequest(options(), request({ tools: [tool] }));
    expect(CreateMessageResultWithToolsSchema.safeParse(result).success).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Checking" }, { type: "tool_use", id: "c1", name: "lookup", input: { id: "42" } }]);
    expect(result.stopReason).toBe("toolUse");
  });

  it("includes only context supplied for the requested server and scope", async () => {
    const context: Context["messages"] = [{ role: "user", content: "authorized", timestamp: 1 }];
    const getContext = vi.fn(() => context);
    await handleSamplingRequest(options({ getContext }), request({ includeContext: "thisServer" }));
    expect(getContext).toHaveBeenCalledWith("test-server", "thisServer", undefined);
    expect(complete.mock.calls[0]?.[1].messages[0]).toEqual(context[0]);
    await handleSamplingRequest(options({ getContext }), request({ includeContext: "none" }));
    expect(getContext).toHaveBeenCalledTimes(1);
    await handleSamplingRequest(options({ getContext }), request({ includeContext: "allServers" }));
    expect(getContext).toHaveBeenLastCalledWith("test-server", "allServers", undefined);
  });

  it("denies context when no authorized callback result is available", async () => {
    for (const getContext of [undefined, () => undefined]) {
      await expect(handleSamplingRequest(options({ ...(getContext ? { getContext } : {}) }), request({ includeContext: "allServers" }))).rejects.toThrow("authorized getContext");
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([1, 2])("preserves consent at approval %s", async declined => {
    const confirm = vi.fn().mockResolvedValueOnce(declined !== 1).mockResolvedValueOnce(false);
    await expect(handleSamplingRequest(options({ autoApprove: false, ui: { confirm } }), request({ tools: [tool], toolChoice: { mode: "auto" } }))).rejects.toThrow("declined");
    expect(complete).toHaveBeenCalledTimes(declined - 1);
    expect(confirm.mock.calls[0]?.[1]).toContain("lookup");
    expect(confirm.mock.calls[0]?.[1]).toContain("toolChoice");
  });

  it.each([1, 2])("cancels while waiting for approval %s", async at => {
    const controller = new AbortController();
    const confirm = vi.fn().mockImplementation(async () => {
      if (confirm.mock.calls.length === at) {
        controller.abort(new Error("cancelled by user"));
        return new Promise<boolean>(() => {});
      }
      return true;
    });
    await expect(handleSamplingRequest(options({ autoApprove: false, ui: { confirm } }), request(), controller.signal)).rejects.toThrow("cancelled by user");
    expect(complete).toHaveBeenCalledTimes(at - 1);
  });

  it("cancels in-flight sampling through the task-time signal", async () => {
    const controller = new AbortController();
    complete.mockImplementation(async (_model, _context, completionOptions) => {
      expect(completionOptions?.signal).toBeInstanceOf(AbortSignal);
      controller.abort(new Error("task cancelled"));
      return new Promise<AssistantMessage>(() => {});
    });
    await expect(handleSamplingRequest(options(), request({ _meta: { "io.modelcontextprotocol/related-task": { taskId: "task1" } } }), controller.signal)).rejects.toThrow("task cancelled");
    expect(complete.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });

  it("rejects legacy augmentation until a receiver owns the lifecycle", async () => {
    await expect(handleSamplingRequest(options(), request({ task: { ttl: 1000 } }))).rejects.toThrow("SDK task receiver");
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    { role: "user", content: { type: "audio", data: "abc", mimeType: "audio/wav" } },
    { role: "assistant", content: { type: "image", data: "abc", mimeType: "image/png" } },
    { role: "user", content: { type: "tool_result", toolUseId: "missing", content: [] } },
  ] satisfies CreateMessageRequest["params"]["messages"])("rejects unsupported or uncorrelated content: %j", async message => {
    await expect(handleSamplingRequest(options(), request({ messages: [message] }))).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  it("reports provider stop sequences distinctly", async () => {
    complete.mockResolvedValue({ ...answer, rawStopReason: "stop_sequence" });
    expect((await handleSamplingRequest(options(), request())).stopReason).toBe("stopSequence");
  });

  it("passes tool responses through the official SDK client and server", async () => {
    const client = new Client({ name: "sampling-client", version: "1" }, { capabilities: { sampling: { tools: {} } } });
    const server = new Server({ name: "sampling-server", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    complete.mockResolvedValue({ ...answer, stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "lookup", arguments: { id: "42" } }] });
    registerSamplingHandler(client, options());
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await server.createMessage(request({ tools: [tool], toolChoice: { mode: "required" } }).params);
      expect(result.content).toEqual([{ type: "tool_use", id: "c1", name: "lookup", input: { id: "42" } }]);
      expect(result.stopReason).toBe("toolUse");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("builds real Pi Anthropic payloads with tools, tool choice and stop sequences", async () => {
    let payload: unknown;
    const nativeComplete: SamplingHandlerOptions["modelRegistry"]["complete"] = async (selected, context, completionOptions) => {
      return anthropicStream({ ...selected, api: "anthropic-messages" }, normalizeContext(context), {
        ...completionOptions,
        apiKey: "unused-no-network",
        onPayload: async original => {
          payload = await completionOptions?.onPayload?.(original, selected) ?? original;
          throw new Error("payload inspected before network");
        },
      }).result();
    };
    await expect(handleSamplingRequest(options({ modelRegistry: { getAvailable: () => [model], complete: nativeComplete } }), request({ tools: [tool], toolChoice: { mode: "required" }, stopSequences: ["END"], temperature: 0.25 }))).rejects.toThrow("payload inspected before network");
    expect(payload).toMatchObject({
      max_tokens: 100, temperature: 0.25, stop_sequences: ["END"], tool_choice: { type: "any" },
      tools: [{ name: "lookup", description: "Look up an item", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }],
    });
  });

  it("runs legacy task sampling through the official receiver lifecycle", async () => {
    const client = new Client({ name: "sampling-client", version: "1" }, { capabilities: { sampling: { tools: {} }, tasks: { list: {}, cancel: {}, requests: { sampling: { createMessage: {} } } } } });
    const server = new Server({ name: "sampling-server", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerSamplingHandler(client, options());
    const receiver = registerSamplingTaskReceiver(client, options());
    expect(receiver.capabilities).toEqual({ list: {}, cancel: {}, requests: { sampling: { createMessage: {} } } });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      let id = 100;
      const send = (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const requestId = id++;
        const previous = serverTransport.onmessage;
        return new Promise((resolve, reject) => {
          serverTransport.onmessage = message => {
            previous?.(message);
            if (!("id" in message) || message.id !== requestId) return;
            serverTransport.onmessage = previous;
            if ("result" in message) resolve(message.result);
            else if ("error" in message) reject(new Error(message.error.message));
          };
          void serverTransport.send({ jsonrpc: "2.0", id: requestId, method, params }).catch(reject);
        });
      };
      const created = CreateTaskResultSchema.parse(await send("sampling/createMessage", request({ task: { ttl: 1000 } }).params));
      const result = await send("tasks/result", { taskId: created.task.taskId });
      expect(CreateMessageResultWithToolsSchema.parse(result)).toMatchObject({ content: { type: "text", text: "done" }, stopReason: "endTurn" });
      expect(await send("tasks/get", { taskId: created.task.taskId })).toMatchObject({ status: "completed" });

      complete.mockImplementation(async () => new Promise<AssistantMessage>(() => {}));
      const pending = CreateTaskResultSchema.parse(await send("sampling/createMessage", request({ task: {} }).params));
      expect(await send("tasks/cancel", { taskId: pending.task.taskId })).toMatchObject({ status: "cancelled" });
      await expect(send("tasks/result", { taskId: pending.task.taskId })).rejects.toThrow("cancelled");
      const samplingSignal = complete.mock.calls.at(-1)?.[2]?.signal;
      expect(samplingSignal?.aborted).toBe(true);
    } finally {
      receiver.close();
      await Promise.all([client.close(), server.close()]);
    }
  });
});
