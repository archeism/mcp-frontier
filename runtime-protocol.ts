/** Mediated protocol extensions. Raw SDK clients and transports stay inside the adapter. */
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Transport } from "@modelcontextprotocol/client";
import type { ServerConnection } from "./server-manager.ts";
import { untracedMessageHandler } from "./mcp-trace.ts";
import { taskId } from "@modelcontextprotocol/ext-tasks/core";
import { withTaskCapabilityV2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import type { TaskCapabilities } from "@modelcontextprotocol/ext-tasks/client";
import { abortable } from "./abort.ts";
import { stableStringify } from "./utils.ts";

export const MCP_PROTOCOL_EVENT = "pi-mcp-adapter:protocol:v1";
export interface McpProtocolDefinition {
  namespace: string;
  requests: string[];
  streams: string[];
  notifications: string[];
}
export interface McpProtocolEnd {
  reason: "cancelled" | "ended" | "error" | "disconnected";
  error?: string;
  /** Preserve JSON-RPC error details for capability-specific recovery decisions. */
  protocolError?: { code: number; message: string; data?: unknown };
}
export interface McpProtocolWatch {
  readonly closed: Promise<McpProtocolEnd>;
  close(): void;
}
export interface McpProtocolStream {
  readonly id: string;
  readonly sent: Promise<void>;
  readonly closed: Promise<McpProtocolEnd>;
  cancel(): Promise<void>;
}
export interface McpProtocolSession {
  readonly signal: AbortSignal;
  readonly protocolVersion: string | undefined;
  readonly serverCapabilities: Record<string, unknown>;
  /** Private restoration binding to configured server identity; not authentication proof. */
  readonly serverBinding?: string;
  /** Lazy draft Events discovery; never changes the SDK's core capability cache. */
  getEventsCapabilities(signal?: AbortSignal): Promise<McpEventsCapabilities | undefined>;
  readonly serverInfo?: { name: string; version: string } | undefined;
  readonly instructions?: string | undefined;
  readonly taskCapabilities?: TaskCapabilities | undefined;
  taskRequest?(action: McpProtocolTaskAction, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** Observe declared notifications outside this adapter's extension streams. */
  watchNotifications(
    methods: string[],
    onNotification: (method: string, params: Record<string, unknown>) => void,
  ): McpProtocolWatch;
  request(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  openStream(
    method: string,
    params: Record<string, unknown>,
    onNotification: (method: string, params: Record<string, unknown>) => void,
  ): McpProtocolStream;
  close(): void;
}
export interface McpEventsCapabilities {
  listChanged?: boolean | undefined;
  [key: string]: unknown;
}
/** Canonical capability accessor for poll, push and webhook consumers. */
export function readEventCapability(
  session: Pick<McpProtocolSession, "getEventsCapabilities">,
  signal?: AbortSignal,
): Promise<McpEventsCapabilities | undefined> {
  return session.getEventsCapabilities(signal);
}
export type McpProtocolTaskAction = "tasks/list" | "tasks/get" | "tasks/result" | "tasks/cancel" | "tasks/update";
export interface McpProtocol {
  connect(server: string): Promise<McpProtocolSession>;
  dispose(): void;
}
// Core methods must continue through the adapter's existing APIs and approval paths.
const reserved = new Set([
  "tools",
  "resources",
  "prompts",
  "sampling",
  "elicitation",
  "logging",
  "roots",
  "completion",
  "completions",
  "tasks",
  "subscriptions",
  "server",
  "client",
  "notifications",
  "rpc",
  "initialize",
  "ping",
]);
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const coreRequests = new Set([
  "ping", "tools/list", "resources/list", "resources/templates/list", "resources/read",
  "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get",
  "completion/complete", "logging/setLevel", "server/discover",
]);
const coreNotifications = new Set([
  "notifications/message", "notifications/progress", "notifications/resources/updated",
  "notifications/resources/list_changed", "notifications/tools/list_changed",
  "notifications/prompts/list_changed", "notifications/subscriptions/acknowledged",
  "notifications/tasks", "notifications/tasks/status",
]);
function validate(raw: McpProtocolDefinition): McpProtocolDefinition {
  if (
    !record(raw) ||
    typeof raw.namespace !== "string" ||
    !/^[a-z][a-z0-9_-]*$/.test(raw.namespace) ||
    reserved.has(raw.namespace)
  )
    throw new Error("Invalid or reserved MCP protocol namespace");
  const names = new Set<string>();
  for (const field of ["requests", "streams", "notifications"] as const) {
    if (!Array.isArray(raw[field]) || raw[field].length > 64)
      throw new Error("Invalid MCP protocol methods");
    const prefix =
      field === "notifications"
        ? `notifications/${raw.namespace}/`
        : `${raw.namespace}/`;
    for (const name of raw[field]) {
      if (
        typeof name !== "string" ||
        !(name.startsWith(prefix) || (raw.namespace === "skills" && field === "requests" &&
          ["resources/read", "resources/directory/read"].includes(name)) ||
          (raw.namespace === "event_webhook" && (field === "requests"
            ? ["events/list", "events/subscribe", "events/unsubscribe"].includes(name)
            : field === "notifications" && name === "notifications/events/list_changed")) ||
          (raw.namespace === "event_delivery" && (field === "requests"
            ? ["events/list", "events/poll"].includes(name)
            : field === "notifications" && name === "notifications/events/list_changed")) ||
          (raw.namespace === "core" && (field === "requests" ? coreRequests.has(name) :
            field === "streams" ? name === "subscriptions/listen" : coreNotifications.has(name)))) ||
        !/^[a-zA-Z0-9_/-]+$/.test(name) ||
        (name.startsWith(prefix) && name.length <= prefix.length) ||
        names.has(name)
      )
        throw new Error("Invalid or duplicate MCP protocol method");
      names.add(name);
    }
  }
  return {
    namespace: raw.namespace,
    requests: [...raw.requests],
    streams: [...raw.streams],
    notifications: [...raw.notifications],
  };
}
function paramsCopy(params: Record<string, unknown>) {
  if (!record(params) || Object.hasOwn(params, "_meta"))
    throw new Error(
      "Protocol parameters must be an object without reserved _meta",
    );
  return structuredClone(params);
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
interface Entry {
  methods: Set<string>;
  notify(method: string, params: Record<string, unknown>): void;
  finish(end: McpProtocolEnd): void;
}
interface Router {
  prefix: string;
  next: number;
  entries: Map<string, Entry>;
  disconnect: Set<() => void>;
  closed: boolean;
  watchers: Set<Entry>;
}
const routers = new WeakMap<Transport, Router>();
function routerFor(connection: ServerConnection): Router {
  const transport = connection.transport;
  const existing = routers.get(transport);
  if (existing) return existing;
  const router: Router = {
    prefix: `mcp-extension-${randomUUID()}-`,
    next: 0,
    entries: new Map(),
    disconnect: new Set(),
    closed: false,
    watchers: new Set(),
  };
  routers.set(transport, router);
  // The router is the outermost handler, so tracing wraps it once; forward to the raw SDK handler.
  const previousMessage = untracedMessageHandler(transport);
  const previousClose = transport.onclose;
  transport.onmessage = (frame, extra) => {
    const raw = frame as any;
    const id =
      typeof raw.id === "string"
        ? raw.id
        : raw.params?._meta?.["io.modelcontextprotocol/subscriptionId"];
    const entry = typeof id === "string" ? router.entries.get(id) : undefined;
    if (entry && !raw.method && ("result" in raw || "error" in raw)) {
      entry.finish(
        "error" in raw
          ? {
              reason: "error",
              error:
                typeof raw.error?.message === "string"
                  ? raw.error.message
                  : "MCP stream error",
              ...(typeof raw.error?.code === "number"
                ? { protocolError: structuredClone(raw.error) }
                : {}),
            }
          : { reason: "ended" },
      );
      return;
    }
    const cancelled =
      raw.method === "notifications/cancelled" &&
      typeof raw.params?.requestId === "string"
        ? router.entries.get(raw.params.requestId)
        : undefined;
    if (cancelled) {
      cancelled.finish({
        reason: "ended",
        error: "MCP server cancelled the stream",
      });
      return;
    }
    if (
      entry &&
      !("id" in raw) &&
      entry.methods.has(raw.method) &&
      record(raw.params)
    ) {
      try {
        void Promise.resolve(entry.notify(raw.method, raw.params)).catch(
          (error) =>
            entry.finish({
              reason: "error",
              error: `Protocol handler failed: ${message(error)}`,
            }),
        );
      } catch (error) {
        entry.finish({
          reason: "error",
          error: `Protocol handler failed: ${message(error)}`,
        });
      }
      return;
    }
    // Ignore late replies/notifications belonging to this router, never unrelated traffic.
    if (!entry && typeof id === "string" && id.startsWith(router.prefix))
      return;
    if (
      !entry &&
      !("id" in raw) &&
      typeof raw.method === "string" &&
      (raw.params === undefined || record(raw.params))
    ) {
      for (const watcher of [...router.watchers]) {
        if (!router.watchers.has(watcher) || !watcher.methods.has(raw.method))
          continue;
        try {
          void Promise.resolve(
            watcher.notify(raw.method, structuredClone(raw.params ?? {})),
          ).catch((error) =>
            watcher.finish({
              reason: "error",
              error: `Protocol handler failed: ${message(error)}`,
            }),
          );
        } catch (error) {
          watcher.finish({
            reason: "error",
            error: `Protocol handler failed: ${message(error)}`,
          });
        }
      }
    }
    previousMessage?.(frame, extra);
  };
  transport.onclose = () => {
    router.closed = true;
    try {
      previousClose?.();
    } finally {
      for (const close of [...router.disconnect]) close();
    }
  };
  return router;
}
function pin(connection: ServerConnection) {
  connection.activeProtocolOperations =
    (connection.activeProtocolOperations ?? 0) + 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    connection.activeProtocolOperations!--;
    connection.lastUsedAt = Date.now();
  };
}

/** Internal implementation; only the mediated session is returned to extensions. */
export function createProtocolSession(
  connection: ServerConnection,
  owner: AbortSignal,
  definition: McpProtocolDefinition,
  serverLabel = "",
): McpProtocolSession {
  const spec = validate(definition);
  if (owner.aborted || connection.status !== "connected")
    throw new Error("MCP connection is unavailable");
  const serverBinding = createHash("sha256").update(stableStringify({
    serverLabel, definition: connection.definition,
  })).digest("hex");
  const router = routerFor(connection);
  if (router.closed) throw new Error("MCP connection is unavailable");
  const controller = new AbortController();
  const active = new Set<(end: McpProtocolEnd) => void>();
  const ensure = (method: string, allowed: string[]) => {
    if (controller.signal.aborted)
      throw new Error("MCP protocol session ended");
    if (!allowed.includes(method))
      throw new Error(`Undeclared MCP protocol method: ${method}`);
  };
  const close = (reason: McpProtocolEnd) => {
    if (controller.signal.aborted) return;
    for (const finish of [...active]) finish(reason);
    controller.abort(new Error(reason.error ?? "MCP protocol session ended"));
    owner.removeEventListener("abort", disconnected);
    router.disconnect.delete(disconnected);
  };
  const disconnected = () =>
    close({ reason: "disconnected", error: "MCP connection or session ended" });
  owner.addEventListener("abort", disconnected, { once: true });
  router.disconnect.add(disconnected);
  let eventsCapabilities: Promise<McpEventsCapabilities | undefined> | undefined;
  return {
    signal: controller.signal,
    serverBinding,
    get protocolVersion() { return connection.client.getNegotiatedProtocolVersion?.(); },
    get serverCapabilities() { return structuredClone(connection.client.getServerCapabilities?.() ?? {}); },
    async getEventsCapabilities(signal) {
      ensure("events/list", spec.requests);
      signal?.throwIfAborted();
      const discovery = eventsCapabilities ??= (async () => {
        const release = pin(connection);
        try {
          const z = await import("zod/v4");
          controller.signal.throwIfAborted();
          const capability = z.object({ listChanged: z.boolean().optional() }).passthrough();
          const known = connection.client.getServerCapabilities?.() as Record<string, unknown> | undefined;
          if (known?.events !== undefined) return capability.parse(known.events);
          // SDK 2.3.1's discovery schema strips draft top-level events. Its
          // generic request path retains them with an explicit result schema.
          const result = await connection.client.request({ method: "server/discover" }, z.object({
            supportedVersions: z.array(z.string()).min(1),
            capabilities: z.object({ events: capability.optional() }).passthrough(),
          }).passthrough(), { signal: controller.signal });
          return result.capabilities.events;
        } finally { release(); }
      })().catch(error => { eventsCapabilities = undefined; throw error; });
      // One caller cancelling must not cancel discovery shared with another.
      const value = await abortable(discovery, signal);
      controller.signal.throwIfAborted();
      return structuredClone(value);
    },
    get serverInfo() { return structuredClone(connection.client.getServerVersion?.()); },
    get instructions() { return connection.client.getInstructions?.(); },
    get taskCapabilities() { return connection.taskSession ? structuredClone(connection.taskSession.capabilities) : undefined; },
    async taskRequest(action, params = {}, signal) {
      if (spec.namespace !== "core" || controller.signal.aborted) throw new Error("Core task management session is unavailable");
      const copy = paramsCopy(params);
      const tasks = connection.taskSession;
      if (!tasks?.capabilities.execution) throw new Error("Server has no supported Tasks SDK session");
      const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      ownedSignal.throwIfAborted();
      const release = pin(connection);
      try {
        if (action === "tasks/list") {
          if (tasks.capabilities.inventory !== "server-list") throw new Error(`Tasks SDK server inventory is unsupported (${tasks.capabilities.inventory})`);
          if (copy.cursor !== undefined && (typeof copy.cursor !== "string" || !copy.cursor)) throw new Error("Task cursor must be a non-empty string");
          return await tasks.listTasks(copy.cursor as string | undefined, ownedSignal);
        }
        if (typeof copy.taskId !== "string" || !copy.taskId.trim()) throw new Error("Task ID is required");
        const id = taskId(copy.taskId);
        if (action === "tasks/cancel") {
          if (!tasks.capabilities.cancellation) throw new Error("Tasks SDK cancellation is unsupported");
          await tasks.cancelTask(id, ownedSignal);
          return {};
        }
        const task = tasks.task(id);
        if (action === "tasks/get") return await task.snapshot(ownedSignal);
        if (action === "tasks/result") {
          const outcome = await task.result({ signal: ownedSignal });
          if (outcome.status !== "failed") return outcome;
          return { ...outcome, error: { message: outcome.error.message, code: outcome.error.code, data: outcome.error.data } };
        }
        if (action === "tasks/update") {
          if (!tasks.capabilities.inputResponses) throw new Error("Tasks SDK input updates are unsupported");
          await task.updateJson(copy.inputResponses, ownedSignal);
          return {};
        }
        throw new Error("Unsupported task management action");
      } finally { release(); }
    },
    watchNotifications(methods, onNotification) {
      if (
        !Array.isArray(methods) ||
        methods.length === 0 ||
        methods.length > 64
      )
        throw new Error("Declared notification methods are required");
      for (const method of methods) ensure(method, spec.notifications);
      if (typeof onNotification !== "function")
        throw new Error("A protocol notification handler is required");
      const release = pin(connection);
      let settle!: (end: McpProtocolEnd) => void;
      const closed = new Promise<McpProtocolEnd>((resolve) => {
        settle = resolve;
      });
      let finished = false;
      const finish = (end: McpProtocolEnd) => {
        if (finished) return;
        finished = true;
        router.watchers.delete(entry);
        active.delete(finish);
        release();
        settle(end);
      };
      const entry: Entry = {
        methods: new Set(methods),
        notify: onNotification,
        finish,
      };
      router.watchers.add(entry);
      active.add(finish);
      return { closed, close: () => finish({ reason: "cancelled" }) };
    },
    async request(method, params = {}, signal) {
      ensure(method, spec.requests);
      const copy = paramsCopy(params);
      const release = pin(connection);
      try {
        const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        ownedSignal.throwIfAborted();
        if (method === "server/discover") {
          if (Object.keys(copy).length) throw new Error("server/discover does not accept parameters");
          return await connection.client.discover({ signal: ownedSignal });
        }
        const z = await import("zod/v4");
        return await connection.client.request(
          { method, params: copy },
          z.record(z.string(), z.unknown()),
          {
            signal: ownedSignal,
          },
        );
      } finally {
        release();
      }
    },
    openStream(method, params, onNotification) {
      ensure(method, spec.streams);
      const copy = paramsCopy(params);
      if (typeof onNotification !== "function")
        throw new Error("A protocol notification handler is required");
      const id = `${router.prefix}${router.next++}`;
      const release = pin(connection);
      let settle!: (end: McpProtocolEnd) => void;
      const closed = new Promise<McpProtocolEnd>((resolve) => {
        settle = resolve;
      });
      let finished = false;
      let dispatched = false;
      const requestController = new AbortController();
      let cancellation: Promise<void> | undefined;
      const cancelWire = () =>
        (cancellation ??=
          router.closed ||
          !dispatched ||
          connection.transport.hasPerRequestStream
            ? Promise.resolve()
            : connection.client
                .notification({
                  method: "notifications/cancelled",
                  params: { requestId: id },
                })
                .catch(() => {}));
      const finish = (end: McpProtocolEnd) => {
        if (finished) return;
        finished = true;
        router.entries.delete(id);
        active.delete(finish);
        release();
        settle(end);
        requestController.abort();
        if (end.reason !== "ended") void cancelWire();
      };
      router.entries.set(id, {
        methods: new Set(spec.notifications),
        notify: onNotification,
        finish,
      });
      active.add(finish);
      // Defer sending until the caller has received the handle and installed its state.
      const sent = Promise.resolve().then(async () => {
        if (finished) return;
        const envelope = connection.requestMetadata?.();
        if (connection.client.getProtocolEra() === "modern" && !envelope)
          throw new Error("MCP client request metadata is unavailable");
        const meta = envelope ? { _meta: envelope } : {};
        const framed = { ...copy, ...meta };
        // Capability contribution follows host framing so neither metadata is lost.
        const streamParams = spec.namespace === "core" && method === "subscriptions/listen" &&
          connection.client.getProtocolEra() === "modern" && record(copy.notifications) &&
          Array.isArray(copy.notifications.taskIds)
          ? withTaskCapabilityV2(framed as Parameters<typeof withTaskCapabilityV2>[0]) : framed;
        dispatched = true;
        await connection.transport.send(
          {
            jsonrpc: "2.0",
            id,
            method,
            params: streamParams,
          },
          {
            requestSignal: requestController.signal,
            onRequestStreamEnd: () =>
              finish({
                reason: "disconnected",
                error: "MCP request stream ended without a final response",
              }),
          },
        );
      });
      void sent.catch((error) =>
        finish({ reason: "error", error: message(error) }),
      );
      return {
        id,
        sent,
        closed,
        async cancel() {
          finish({ reason: "cancelled" });
          await cancelWire();
        },
      };
    },
    close: () => close({ reason: "cancelled" }),
  };
}

interface ProtocolRequest {
  version: 1;
  definition: McpProtocolDefinition;
  result?: McpProtocol;
  error?: Error;
}
export function registerProtocolBridge(
  pi: ExtensionAPI,
  resolve: (
    name: string,
  ) => Promise<{ connection: ServerConnection; signal: AbortSignal }>,
): void {
  const registrations = new Set<string>();
  pi.events.on(MCP_PROTOCOL_EVENT, (raw: unknown) => {
    if (!record(raw) || raw.result !== undefined || raw.error !== undefined)
      return;
    const request = raw as ProtocolRequest;
    try {
      if (request.version !== 1)
        throw new Error("Invalid MCP protocol registration version");
      const definition = validate(request.definition);
      if (registrations.has(definition.namespace))
        throw new Error(
          `MCP protocol already registered: ${definition.namespace}`,
        );
      registrations.add(definition.namespace);
      let disposed = false;
      const sessions = new Set<McpProtocolSession>();
      request.result = {
        async connect(name) {
          if (disposed) throw new Error("MCP protocol registration disposed");
          if (typeof name !== "string" || !name.trim())
            throw new Error("MCP server name is required");
          const target = await resolve(name);
          if (disposed) throw new Error("MCP protocol registration disposed");
          const session = createProtocolSession(
            target.connection,
            target.signal,
            definition,
            name,
          );
          sessions.add(session);
          session.signal.addEventListener(
            "abort",
            () => sessions.delete(session),
            { once: true },
          );
          return session;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          registrations.delete(definition.namespace);
          for (const session of sessions) session.close();
          sessions.clear();
        },
      };
    } catch (error) {
      request.error = error instanceof Error ? error : new Error(String(error));
    }
  });
}
export function registerMcpProtocol(
  pi: ExtensionAPI,
  definition: McpProtocolDefinition,
): McpProtocol {
  const request: ProtocolRequest = { version: 1, definition };
  pi.events.emit(MCP_PROTOCOL_EVENT, request);
  if (request.error) throw request.error;
  if (!request.result)
    throw new Error("pi-mcp-adapter does not expose protocol extensions");
  return request.result;
}
