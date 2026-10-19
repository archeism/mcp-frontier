import { Type } from "typebox";
import { z } from "zod/v4";
import { toJsonValue } from "@modelcontextprotocol/ext-tasks/core";
import { contributeTaskFilterV2, readAcceptedTaskIdsV2, hasTaskServerCapabilityV2, TaskStatusNotificationV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { TaskStatusNotificationV1Schema } from "@modelcontextprotocol/ext-tasks/core/v1";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMcpProtocol, type McpProtocolSession, type McpProtocolStream, type McpProtocolWatch, type McpProtocolTaskAction } from "./runtime-protocol.ts";
import { MCP_RUNTIME_TOOL_CALL_EVENT, MCP_RUNTIME_TOOL_CALL_VERSION, type McpRuntimeToolCallRequest } from "./index.ts";

export const CORE_PROTOCOL = {
  namespace: "core",
  requests: ["ping", "tools/list", "resources/list", "resources/templates/list", "resources/read", "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel", "server/discover"],
  streams: ["subscriptions/listen"],
  notifications: ["notifications/message", "notifications/progress", "notifications/resources/updated", "notifications/resources/list_changed", "notifications/tools/list_changed", "notifications/prompts/list_changed", "notifications/subscriptions/acknowledged", "notifications/tasks", "notifications/tasks/status"],
};
const object = z.record(z.string(), z.unknown());
const filters = z.object({ toolsListChanged: z.boolean().optional(), promptsListChanged: z.boolean().optional(), resourcesListChanged: z.boolean().optional(), resourceSubscriptions: z.array(z.string()).optional(), taskIds: z.array(z.string().min(1)).max(1000).optional() }).strict();
type SubscriptionFilter = z.infer<typeof filters>;
export const CORE_ACK_TIMEOUT_MS = 5000;
const lists: Record<string, string> = { "tools/list": "tools", "resources/list": "resources", "resources/templates/list": "resourceTemplates", "prompts/list": "prompts" };
const taskActions = ["tasks/list", "tasks/get", "tasks/result", "tasks/cancel", "tasks/update"] as const;
const actions = ["discover", "status", ...CORE_PROTOCOL.requests, ...taskActions, "tool/call", "tools/call", "subscriptions/listen", "watch", "stop", "notifications/list"];

/** A core client owns only mediated sessions; the adapter owns SDK and task execution. */
export class CoreClient {
  readonly records: Array<{ method: string; params: Record<string, unknown> }> = [];
  private watches = new Map<string, { stop(): Promise<void>; state: string; error: string | undefined; honored: SubscriptionFilter | undefined }>();
  private next = 0;
  constructor(readonly session: McpProtocolSession, private deliver?: (value: unknown) => void) {}
  private modern() { return this.session.protocolVersion === "2026-07-28"; }
  private require(method: string) {
    const name = method.split("/")[0]!;
    const cap = name === "completion" ? "completions" : name;
    if (name !== "ping" && !this.session.serverCapabilities[cap]) throw new Error(`Server does not declare ${cap}`);
    if (method === "resources/subscribe" && !this.modern() && !(this.session.serverCapabilities.resources as { subscribe?: boolean })?.subscribe)
      throw new Error("Server does not declare resource subscriptions");
  }
  status() {
    return { protocolVersion: this.session.protocolVersion, serverCapabilities: this.session.serverCapabilities, serverInfo: this.session.serverInfo, instructions: this.session.instructions, taskCapabilities: this.session.taskCapabilities, closed: this.session.signal.aborted,
      watches: [...this.watches].map(([id, watch]) => ({ id, state: watch.state, error: watch.error, notifications: structuredClone(watch.honored) })), notifications: structuredClone(this.records) };
  }
  private receive = (method: string, params: Record<string, unknown>) => {
    const item = { method, params: structuredClone(params) };
    this.records.push(item);
    if (this.records.length > 200) this.records.shift();
    this.deliver?.(item);
  };
  async watch(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ id: string; notifications?: SubscriptionFilter }> {
    signal?.throwIfAborted();
    if (this.watches.size >= 100) throw new Error("Core watch limit reached; stop existing watches first");
    const notifications = filters.parse(params.notifications ?? {});
    for (const [key, value] of Object.entries(notifications)) {
      if (!value || (Array.isArray(value) && !value.length)) continue;
      if (key === "taskIds") {
        if (this.modern() && !hasTaskServerCapabilityV2(this.session.serverCapabilities)) throw new Error("Server does not declare Tasks extension");
        continue;
      }
      this.require(key === "toolsListChanged" ? "tools/list" : key === "promptsListChanged" ? "prompts/list" : "resources/list");
      if (key === "resourceSubscriptions") this.require("resources/subscribe");
    }
    let stream: McpProtocolStream | undefined;
    let observer: McpProtocolWatch | undefined;
    const id = `core-${++this.next}`;
    let acknowledge = () => {};
    let rejectReady = (_error: Error) => {};
    const ready = this.modern() ? new Promise<void>((resolve, reject) => { acknowledge = resolve; rejectReady = reject; }) : Promise.resolve();
    // Attach immediately, including when opening the mediated stream throws synchronously.
    void ready.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = {
      state: this.modern() ? "starting" : "active", error: undefined as string | undefined,
      honored: undefined as SubscriptionFilter | undefined,
      stop: async () => {
        rejectReady(new Error("Core watch cancelled before acknowledgement"));
        if (entry.state === "starting" || entry.state === "active") entry.state = "cancelled";
        release(); observer?.close(); await stream?.cancel();
      },
    };
    const abort = () => { void entry.stop(); };
    const release = () => {
      signal?.removeEventListener("abort", abort);
      this.session.signal.removeEventListener("abort", abort);
    };
    try {
      observer = this.session.watchNotifications(CORE_PROTOCOL.notifications, (method, raw) => {
        // Modern task updates belong only to the acknowledged subscription.
        if (method === "notifications/tasks") return;
        if (method === "notifications/tasks/status") {
          if (this.modern()) return;
          const parsed = TaskStatusNotificationV1Schema.safeParse({ jsonrpc: "2.0", method, params: raw });
          if (!parsed.success || (notifications.taskIds && !notifications.taskIds.includes(parsed.data.params.taskId))) return;
        }
        this.receive(method, raw);
      });
      if (this.modern()) {
        timer = setTimeout(() => rejectReady(new Error("Timed out waiting for subscriptions/acknowledged")), CORE_ACK_TIMEOUT_MS);
        const filter = notifications.taskIds === undefined ? { notifications } : contributeTaskFilterV2({ notifications: toJsonValue(notifications) }, notifications.taskIds);
        stream = this.session.openStream("subscriptions/listen", filter, (method, raw) => {
          try {
            if (!entry.honored) {
              if (method !== "notifications/subscriptions/acknowledged") throw new Error("Expected subscriptions/acknowledged as first stream notification");
              const honored = filters.parse(raw.notifications);
              for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"] as const)
                if (honored[key] === true && notifications[key] !== true) throw new Error("Server acknowledged an unrequested notification filter");
              if (honored.resourceSubscriptions?.some(uri => !notifications.resourceSubscriptions?.includes(uri)))
                throw new Error("Server acknowledged an unrequested resource subscription");
              if (readAcceptedTaskIdsV2(raw).some(task => !notifications.taskIds?.includes(task)))
                throw new Error("Server acknowledged an unrequested task subscription");
              entry.honored = honored; entry.state = "active";
              this.receive(method, raw); acknowledge();
            } else {
              if (method === "notifications/tasks") {
                const task = TaskStatusNotificationV2Schema.parse({ jsonrpc: "2.0", method, params: raw });
                if (!entry.honored.taskIds?.includes(task.params.taskId)) throw new Error("Unsolicited task status notification");
              }
              if (method === "notifications/tasks/status") throw new Error("Legacy task notification on modern stream");
              this.receive(method, raw);
            }
          } catch (error) {
            entry.error = String(error); entry.state = "error";
            rejectReady(error instanceof Error ? error : new Error(String(error)));
            void entry.stop();
          }
        });
      }
      else if ((notifications.resourceSubscriptions?.length ?? 0) > 0)
        throw new Error("Use resources/subscribe for legacy resource subscriptions");
      this.watches.set(id, entry);
      signal?.addEventListener("abort", abort, { once: true });
      this.session.signal.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || this.session.signal.aborted) abort();
      void (stream?.closed ?? observer.closed).then(end => {
        rejectReady(new Error(end.error ?? "Core watch ended before acknowledgement"));
        entry.state = end.reason; entry.error = end.error;
        observer?.close(); release();
      });
      await Promise.all([stream?.sent, ready]);
      signal?.throwIfAborted();
      this.session.signal.throwIfAborted();
      return { id, ...(entry.honored ? { notifications: structuredClone(entry.honored) } : {}) };
    } catch (error) { await entry.stop(); this.watches.delete(id); throw error; }
    finally { clearTimeout(timer); }
  }
  async stop(id?: string) {
    if (id && !this.watches.has(id)) throw new Error("Unknown core watch");
    for (const [key, watch] of [...this.watches]) if (!id || key === id) { await watch.stop(); this.watches.delete(key); }
    return { stopped: id ?? "all" };
  }
  async execute(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (action === "status") return this.status();
    if (action === "discover" || action === "server/discover") {
      if (!this.modern()) return { ...this.status(), source: "negotiated connection metadata", refreshed: false, message: "Fresh server/discover is unsupported on this legacy connection" };
      const result = object.parse(await this.session.request("server/discover", params, signal));
      return { ...result, source: "server/discover", refreshed: true };
    }
    if (taskActions.includes(action as McpProtocolTaskAction)) {
      if (!this.session.taskRequest) throw new Error("Mediated task management is unavailable");
      if (action !== "tasks/list") return this.session.taskRequest(action as McpProtocolTaskAction, params, signal);
      const tasks: unknown[] = [], cursors = new Set<string>();
      if (typeof params.cursor === "string") cursors.add(params.cursor);
      let next = { ...params };
      for (let page = 0; page < 1000; page++) {
        const result = object.parse(await this.session.taskRequest("tasks/list", next, signal));
        tasks.push(...z.array(z.unknown()).parse(result.tasks));
        if (result.nextCursor === undefined) return { ...result, tasks };
        const cursor = z.string().min(1).parse(result.nextCursor);
        if (cursors.has(cursor)) throw new Error("Repeated Tasks pagination cursor");
        cursors.add(cursor); next = { ...params, cursor };
      }
      throw new Error("Tasks pagination limit exceeded; result incomplete");
    }
    if (action === "notifications/list") return structuredClone(this.records);
    if (action === "stop") return this.stop(params.id === undefined ? undefined : z.string().parse(params.id));
    if (action === "watch" || action === "subscriptions/listen") return this.watch(params, signal);
    if (!CORE_PROTOCOL.requests.includes(action)) throw new Error("Unsupported core action");
    this.require(action);
    if (["resources/subscribe", "resources/unsubscribe"].includes(action) && this.modern()) {
      if (action === "resources/unsubscribe") return this.stop(z.string().parse(params.id));
      return this.watch({ notifications: { resourceSubscriptions: [z.string().min(1).parse(params.uri)] } }, signal);
    }
    const field = lists[action];
    if (!field) return this.session.request(action, params, signal);
    const values: unknown[] = [], cursors = new Set<string>();
    let next = { ...params };
    if (typeof params.cursor === "string") cursors.add(params.cursor);
    for (let page = 0; page < 1000; page++) {
      const result = object.parse(await this.session.request(action, next, signal));
      values.push(...z.array(z.unknown()).parse(result[field]));
      if (result.nextCursor === undefined) return { ...result, [field]: values };
      const cursor = z.string().min(1).parse(result.nextCursor);
      if (cursors.has(cursor)) throw new Error("Repeated MCP pagination cursor");
      cursors.add(cursor); next = { ...params, cursor };
    }
    throw new Error("MCP pagination limit exceeded; result incomplete");
  }
  close() { this.session.close(); this.watches.clear(); }
}

export function installCore(pi: ExtensionAPI): void {
  let protocol: ReturnType<typeof registerMcpProtocol> | undefined;
  const clients = new Map<string, CoreClient>();
  const pending = new Map<string, Promise<CoreClient>>();
  let generation = 0;
  const client = async (server: string) => {
    const old = clients.get(server);
    if (old && !old.session.signal.aborted) return old;
    if (pending.has(server)) return pending.get(server)!;
    protocol ??= registerMcpProtocol(pi, CORE_PROTOCOL);
    const current = generation;
    const promise = protocol.connect(server).then(session => {
      if (current !== generation) { session.close(); throw new Error("MCP session replaced"); }
      const value = new CoreClient(session, record => pi.sendMessage({ customType: "mcp-protocol-notification", content: JSON.stringify({ server, notification: record }), display: true }, { triggerTurn: false }));
      clients.set(server, value); return value;
    }).finally(() => { if (pending.get(server) === promise) pending.delete(server); });
    pending.set(server, promise); return promise;
  };
  pi.registerTool({
    name: "mcp_protocol", label: "MCP Protocol",
    description: "Discover fresh MCP metadata on modern servers or inspect status; use tools, resources, prompts, completion, logging, notification watches, or tasks/list,get,result,cancel,update. Supply server, action and protocol params. Lists follow pagination. Modern subscriptions return a watch id; unsubscribe uses params.id. Task operations use params.taskId; update uses inputResponses. Task inventory requires SDK support. Tool calls preserve approval and Tasks.",
    parameters: Type.Object({ server: Type.String({ minLength: 1 }), action: Type.Union(actions.map(value => Type.Literal(value))), params: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    async execute(_id, args, signal) {
      try {
        signal?.throwIfAborted();
        const params = object.parse(args.params ?? {});
        if (args.action === "tool/call" || args.action === "tools/call") {
          const request: McpRuntimeToolCallRequest = { version: MCP_RUNTIME_TOOL_CALL_VERSION, toolCallId: _id, server: args.server, tool: z.string().min(1).parse(params.name), args: object.parse(params.arguments ?? {}), ...(signal ? { signal } : {}) };
          pi.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);
          if (!request.result) throw new Error("Adapter runtime tool-call bridge unavailable");
          const result = await request.result;
          if (!result.ok) throw result.error;
          return result.result;
        }
        const result = await (await client(args.server)).execute(args.action, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { server: args.server, action: args.action } };
      } catch (error) { return { content: [{ type: "text", text: String(error) }], details: {}, isError: true }; }
    },
  });
  const reset = () => { generation++; for (const value of clients.values()) value.close(); protocol?.dispose(); protocol = undefined; clients.clear(); pending.clear(); };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
}
