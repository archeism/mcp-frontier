import { abortable, throwIfAborted } from "./abort.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/core";
import { toJsonValue } from "@modelcontextprotocol/ext-tasks/core";
import { bindTaskReceiver } from "@modelcontextprotocol/ext-tasks/receiver";
export function registerSamplingHandler(client, options) {
    client.setRequestHandler("sampling/createMessage", (request, ctx) => {
        return handleSamplingRequest(options, request, ctx.mcpReq.signal);
    });
}
/** Install after the plain handler, before connecting; host advertises capabilities and closes the binding. */
export function registerSamplingTaskReceiver(client, options) {
    return bindTaskReceiver(client, {
        methods: { "sampling/createMessage": true },
        sampling: async (request, context) => {
            const parsed = CreateMessageRequestSchema.parse(request);
            // The official receiver owns task augmentation; the completion handler sees only sampling params.
            const { task: _task, ...params } = parsed.params;
            const result = await handleSamplingRequest(options, { method: "sampling/createMessage", params }, context.signal);
            const encoded = toJsonValue(result);
            if (encoded === null || typeof encoded !== "object" || Array.isArray(encoded))
                throw new Error("Invalid MCP sampling result");
            return Object.fromEntries(Object.entries(encoded));
        },
    });
}
export async function handleSamplingRequest(options, request, requestSignal) {
    const params = request.params;
    const signals = [options.getSignal(), requestSignal].filter((value) => value !== undefined);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    throwIfAborted(signal);
    if ("task" in params && params.task) {
        throw new Error("Task-augmented sampling requires an SDK task receiver to own the task lifecycle");
    }
    let context = [];
    if (params.includeContext && params.includeContext !== "none") {
        const authorized = options.getContext && await abortable(Promise.resolve(options.getContext(options.serverName, params.includeContext, signal)), signal);
        if (!authorized)
            throw new Error("MCP sampling context inclusion is not supported without authorized getContext");
        context = authorized;
    }
    let messages = [...context, ...convertSamplingMessages(params.messages, context)];
    const model = resolveSamplingModel(options, params.modelPreferences);
    if (messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "image")) && !model.input.includes("image")) {
        throw new Error(`MCP sampling image content is not supported by ${model.provider}/${model.id}`);
    }
    const completionOptions = samplingOptions(model, params);
    const edited = await editSamplingPrompt(options, params.systemPrompt, messages, signal);
    const systemPrompt = edited.systemPrompt;
    messages = edited.messages;
    throwIfAborted(signal);
    await abortable(confirmSampling(options, "Approve MCP sampling request", formatRequestApproval(options.serverName, `${model.provider}/${model.id}`, systemPrompt, messages, context.length)
        + `\n\nOptions: ${JSON.stringify({ includeContext: params.includeContext, tools: params.tools, toolChoice: params.toolChoice, stopSequences: params.stopSequences, maxTokens: params.maxTokens, temperature: params.temperature, metadata: params.metadata })}`, signal), signal);
    throwIfAborted(signal);
    const result = await abortable(options.modelRegistry.complete(model, {
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        messages,
        ...(params.tools ? { tools: params.tools.map(tool => ({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema })) } : {}),
    }, {
        ...completionOptions,
        ...(signal ? { signal } : {}),
    }), signal);
    const converted = convertAssistantResult(result);
    throwIfAborted(signal);
    await abortable(confirmSampling(options, "Return MCP sampling response", formatResponseApproval(options.serverName, converted), signal), signal);
    throwIfAborted(signal);
    return converted;
}
function formatRequestApproval(serverName, modelName, systemPrompt, messages, contextCount = 0) {
    const lines = [`${serverName} wants to sample ${messages.length} message${messages.length === 1 ? "" : "s"} with ${modelName}.`];
    lines.push(`First ${contextCount} messages: authorized host context. Remaining messages and system prompt: untrusted server-supplied history, not proof of Pi tool execution. Tools are returned to the server, not executed by Pi.`);
    if (systemPrompt) {
        lines.push(`System: ${systemPrompt}`);
    }
    for (const [index, message] of messages.entries()) {
        lines.push(`${index + 1}. ${message.role}: ${messageText(message)}`);
    }
    return lines.join("\n\n");
}
function formatResponseApproval(serverName, response) {
    const blocks = Array.isArray(response.content) ? response.content : [response.content];
    const text = blocks.map(block => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
    return `${serverName} will receive this response from ${response.model}:\n\n${text}`;
}
function messageText(message) {
    if (typeof message.content === "string")
        return message.content;
    const identity = message.role === "toolResult" ? `Tool: ${message.toolName}; call: ${message.toolCallId}; isError: ${message.isError}\n` : "";
    return identity + message.content.map((block) => {
        if (block.type === "text")
            return block.text;
        if (block.type === "image")
            return `[image: ${block.mimeType}; binary pixels are not displayed in this text review]`;
        if (block.type === "thinking")
            return "[private thinking is not displayed]";
        if (block.type === "toolCall")
            return `[tool call: ${block.name}; id: ${block.id}; arguments: ${JSON.stringify(block.arguments)}]`;
        return "[content]";
    }).join("\n");
}
async function editSamplingPrompt(options, systemPrompt, messages, signal) {
    const ui = options.ui;
    if (options.autoApprove || !ui?.select || !ui.editor)
        return { systemPrompt, messages };
    // Never mutate the authorized context or the server's request while editing.
    messages = structuredClone(messages);
    while (true) {
        const choice = await abortable(ui.select(`Review MCP sampling prompt\nServer: ${options.serverName}\nFull request and response confirmation follows.`, ["Continue", "Edit prompt", "Decline"], signal ? { signal } : undefined), signal);
        if (choice === "Continue")
            return { systemPrompt, messages };
        if (choice !== "Edit prompt")
            throw new Error("MCP sampling request was declined");
        const fields = [
            { label: "System prompt", value: systemPrompt ?? "", set(value) { systemPrompt = value; } },
        ];
        for (const [index, message] of messages.entries()) {
            if (typeof message.content === "string") {
                fields.push({ label: `Message ${index + 1} (${message.role}) text`, value: message.content, set(value) { message.content = value; } });
            }
            else
                for (const [part, block] of message.content.entries()) {
                    if (block.type === "text")
                        fields.push({ label: `Message ${index + 1} (${message.role}) text ${part + 1}`, value: block.text, set(value) { block.text = value; } });
                    if (block.type === "toolCall")
                        fields.push({ label: `Message ${index + 1} tool ${block.name} arguments ${part + 1}`, value: JSON.stringify(block.arguments, null, 2), set(value) { block.arguments = jsonObject(JSON.parse(value)); } });
                }
        }
        const selected = await abortable(ui.select("Select prompt text or tool arguments to edit (images/private thinking are not text-editable)", fields.map(field => field.label), signal ? { signal } : undefined), signal);
        const field = fields.find(field => field.label === selected);
        if (!field)
            throw new Error("MCP sampling request was declined");
        const value = await abortable(ui.editor(field.label, field.value), signal);
        if (value === undefined)
            throw new Error("MCP sampling request was declined");
        throwIfAborted(signal);
        field.set(value);
    }
}
function resolveSamplingModel(options, modelPreferences) {
    const candidates = [];
    const availableModels = options.modelRegistry.getAvailable();
    for (const hint of modelPreferences?.hints ?? []) {
        const normalizedHint = hint.name?.trim().toLowerCase();
        if (!normalizedHint)
            continue;
        for (const model of availableModels) {
            const searchableNames = [`${model.provider}/${model.id}`, model.id, model.name];
            if (searchableNames.some((name) => name.toLowerCase().includes(normalizedHint))) {
                addSamplingCandidate(candidates, model);
            }
        }
    }
    const currentModel = options.getCurrentModel();
    if (currentModel)
        addSamplingCandidate(candidates, currentModel);
    for (const model of availableModels) {
        addSamplingCandidate(candidates, model);
    }
    const signal = options.getSignal();
    throwIfAborted(signal);
    const model = candidates[0];
    if (model)
        return model;
    throw new Error("No Pi model is available for MCP sampling");
}
function addSamplingCandidate(candidates, model) {
    if (!candidates.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
        candidates.push(model);
    }
}
async function confirmSampling(options, title, message, signal) {
    if (options.autoApprove)
        return;
    if (!options.ui) {
        throw new Error("MCP sampling requires interactive approval. Set settings.samplingAutoApprove to true to allow it without UI.");
    }
    const approved = await options.ui.confirm(title, message, signal ? { signal } : undefined);
    if (!approved) {
        throw new Error("MCP sampling request was declined");
    }
}
function convertSamplingMessages(input, context) {
    const messages = [];
    const calls = new Map();
    for (const message of context) {
        if (message.role === "assistant")
            for (const block of message.content) {
                if (block.type === "toolCall")
                    calls.set(block.id, block.name);
            }
    }
    for (const message of input) {
        const blocks = Array.isArray(message.content) ? message.content : [message.content];
        if (message.role === "assistant") {
            const content = blocks.map(block => {
                if (block.type === "text")
                    return { type: "text", text: block.text };
                if (block.type === "tool_use") {
                    if (calls.has(block.id))
                        throw new Error(`Duplicate MCP sampling tool use id: ${block.id}`);
                    calls.set(block.id, block.name);
                    return { type: "toolCall", id: block.id, name: block.name, arguments: jsonObject(block.input) };
                }
                throw new Error(`MCP sampling assistant ${block.type} content is not supported by Pi 1.3`);
            });
            messages.push({ role: "assistant", content, api: "mcp-sampling", provider: "mcp", model: "sampling-request", usage: zeroUsage(), stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() });
        }
        else {
            let content = [];
            const flush = () => {
                if (content.length)
                    messages.push({ role: "user", content, timestamp: Date.now() });
                content = [];
            };
            for (const block of blocks) {
                if (block.type !== "tool_result") {
                    content.push(convertUserContent(block));
                    continue;
                }
                flush();
                const toolName = calls.get(block.toolUseId);
                if (!toolName)
                    throw new Error(`MCP sampling tool result has no matching tool use: ${block.toolUseId}`);
                const resultContent = block.content.map(part => {
                    if (part.type === "text" || part.type === "image")
                        return convertUserContent(part);
                    // Resource links are references, never permission to fetch their contents.
                    if (part.type === "resource_link")
                        return { type: "text", text: JSON.stringify(part) };
                    if (part.type === "resource" && "text" in part.resource)
                        return { type: "text", text: part.resource.text };
                    throw new Error(`MCP sampling tool result ${part.type} content is not supported by Pi 1.3`);
                });
                if (block.structuredContent !== undefined)
                    resultContent.push({ type: "text", text: JSON.stringify(jsonValue(block.structuredContent)) });
                messages.push({ role: "toolResult", toolCallId: block.toolUseId, toolName, content: resultContent, isError: block.isError ?? false, timestamp: Date.now() });
                calls.delete(block.toolUseId);
            }
            flush();
        }
    }
    return messages;
}
function convertUserContent(block) {
    if (block.type === "text")
        return { type: "text", text: block.text };
    if (block.type === "image")
        return { type: "image", data: block.data, mimeType: block.mimeType };
    throw new Error(`MCP sampling ${block.type} content is not supported by Pi 1.3`);
}
// MCP tool inputs are unknown-valued records; Pi requires actual JSON values.
function jsonValue(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (Array.isArray(value))
        return value.map(jsonValue);
    if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
    }
    throw new Error("MCP sampling content must contain only JSON values");
}
function jsonObject(value) {
    const converted = jsonValue(value);
    if (converted === null || typeof converted !== "object" || Array.isArray(converted))
        throw new Error("MCP sampling tool input must be a JSON object");
    // Array.isArray does not narrow readonly arrays in JsonValue.
    return Object.fromEntries(Object.entries(converted));
}
function samplingOptions(model, params) {
    const options = {
        maxTokens: params.maxTokens,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };
    const mode = params.toolChoice?.mode;
    if (mode === "required" && !params.tools?.length)
        throw new Error("MCP sampling required tool choice requires tools");
    if (mode) {
        switch (model.api) {
            case "anthropic-messages":
            case "bedrock-converse-stream":
            case "google-generative-ai":
            case "google-vertex":
                options.toolChoice = mode === "required" ? "any" : mode;
                break;
            case "openai-completions":
            case "openai-responses":
            case "azure-openai-responses":
            case "openai-codex-responses":
            case "mistral-conversations":
            case "pi-messages":
                options.toolChoice = mode;
                break;
            default: throw new Error(`MCP sampling tool choice is not supported for Pi API ${model.api}`);
        }
    }
    if (params.stopSequences?.length) {
        const stop = params.stopSequences;
        const api = model.api;
        if (!["anthropic-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex", "openai-completions", "mistral-conversations"].includes(api)) {
            throw new Error(`MCP sampling stop sequences are not supported for Pi API ${api}`);
        }
        options.onPayload = payload => {
            if (typeof payload !== "object" || payload === null || Array.isArray(payload))
                throw new Error("Invalid Pi sampling provider payload");
            if (api === "anthropic-messages")
                return { ...payload, stop_sequences: stop };
            if (api === "google-generative-ai" || api === "google-vertex") {
                const config = "config" in payload ? payload.config : undefined;
                if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config)))
                    throw new Error("Invalid Pi Google config");
                return { ...payload, config: { ...config, stopSequences: stop } };
            }
            if (api === "bedrock-converse-stream") {
                const config = "inferenceConfig" in payload ? payload.inferenceConfig : undefined;
                if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config)))
                    throw new Error("Invalid Pi Bedrock inferenceConfig");
                return { ...payload, inferenceConfig: { ...config, stopSequences: stop } };
            }
            return { ...payload, stop };
        };
    }
    return options;
}
function convertAssistantResult(message) {
    if (message.stopReason === "error") {
        throw new Error(message.errorMessage ?? "MCP sampling model call failed");
    }
    if (message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? "MCP sampling model call was aborted");
    }
    if (message.stopReason === "pending" || message.stopReason === "deferred")
        throw new Error("MCP sampling model did not return a completed response");
    const content = [];
    for (const block of message.content) {
        if (block.type === "text")
            content.push({ type: "text", text: block.text });
        if (block.type === "toolCall") {
            if (block.argumentsError)
                throw new Error(block.argumentsError);
            content.push({ type: "tool_use", id: block.id, name: block.name, input: jsonObject(block.arguments) });
        }
    }
    if (!content.length)
        throw new Error("MCP sampling result did not contain text or tool use content");
    const hasTools = content.some(block => block.type === "tool_use");
    const text = content.filter(block => block.type === "text").map(block => block.text).join("\n\n").trim();
    if (!hasTools && !text)
        throw new Error("MCP sampling result did not contain text content");
    return {
        role: "assistant",
        content: hasTools ? content : { type: "text", text },
        model: `${message.provider}/${message.model}`,
        stopReason: hasTools ? "toolUse" : message.rawStopReason === "stop_sequence" ? "stopSequence" : mapStopReason(message.stopReason),
    };
}
function mapStopReason(reason) {
    if (reason === "stop")
        return "endTurn";
    if (reason === "length")
        return "maxTokens";
    if (reason === "toolUse")
        return "toolUse";
    return reason;
}
function zeroUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    };
}
//# sourceMappingURL=sampling-handler.js.map