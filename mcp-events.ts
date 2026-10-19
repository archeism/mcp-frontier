import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentPath } from "./agent-dir.ts";
import { registerMcpProtocol } from "./runtime-protocol.ts";
import { EventsCoordinator, EVENTS_COORDINATOR_PROTOCOL, type EventSubscriptionStatus } from "./mcp-events-coordinator.ts";
import { EventsRegistry } from "./mcp-events-registry.ts";
import { DurableWebhookInbox } from "./mcp-events-inbox.ts";
import { installEventDelivery, type EventPresentationPolicy } from "./mcp-events-pi-delivery.ts";
import type { WebhookReceiver } from "./mcp-events-webhook.ts";
export type { EventPresentationPolicy } from "./mcp-events-pi-delivery.ts";

/** Read-only application diagnostics, never model instructions or action grants. */
export const MCP_EVENTS_STATUS_EVENT = "pi-mcp-adapter:events-status:v1";
export type McpEventsStatusSignal = Readonly<EventSubscriptionStatus & { version: 1; sessionId: string }>;

export interface EventsOptions {
  /** Optional operator-owned pre-LLM redaction/sandbox policy; rejection retains pending data. */
  presentEvent?: EventPresentationPolicy;
  /** Private session storage; defaults below Pi's agent directory. */
  storageRoot?: string;
  /** Operator-owned HTTPS endpoint, optionally backed by startWebhookListener. */
  webhook?: { receiver: WebhookReceiver; callbackBaseUrl: string };
}

/** One Pi-facing tool over all three draft delivery modes. */
export function installCanonicalEvents(pi: ExtensionAPI, options: EventsOptions = {}) {
  const storageRoot = options.storageRoot ?? getAgentPath("mcp-events");
  let context: ExtensionContext | undefined;
  let generation = 0;
  let coordinator: EventsCoordinator | undefined;
  let registry: EventsRegistry | undefined;
  let protocol: ReturnType<typeof registerMcpProtocol> | undefined;
  let initializing: Promise<EventsCoordinator> | undefined;
  let teardown: Promise<void> = Promise.resolve();
  const bridge = installEventDelivery(pi, {
    pending: async () => coordinator ? coordinator.pending() : [],
    acknowledge: async rows => { if (!coordinator) throw new Error("Events session ended"); await coordinator.acknowledge(rows); },
  }, options.presentEvent);
  const directory = (ctx: ExtensionContext) => join(storageRoot,
    createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex"));
  const reset = () => {
    generation++;
    const oldInitialization = initializing;
    const oldCoordinator = coordinator, oldRegistry = registry, oldProtocol = protocol;
    // Detach synchronously: the bridge's new session must never observe the
    // previous session's inbox while asynchronous teardown is still running.
    initializing = undefined; coordinator = undefined; registry = undefined; protocol = undefined;
    teardown = teardown.then(async () => {
      await oldInitialization?.catch(() => {});
      await oldCoordinator?.close();
      await oldRegistry?.close();
      oldProtocol?.dispose();
    });
    return teardown;
  };
  const ensure = async (ctx: ExtensionContext): Promise<EventsCoordinator> => {
    const current = generation;
    await teardown;
    if (current !== generation || context?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId())
      return Promise.reject(new Error("Pi Events session identity changed"));
    if (initializing) return initializing;
    if (coordinator) return Promise.resolve(coordinator);
    initializing = (async () => {
      const ownedRegistry = await EventsRegistry.open(directory(ctx), ctx.sessionManager.getSessionId());
      if (current !== generation) { await ownedRegistry.close(); throw new Error("Events session replaced"); }
      registry = ownedRegistry;
      let ownedProtocol: ReturnType<typeof registerMcpProtocol> | undefined;
      let value: EventsCoordinator | undefined;
      try {
      const inboxLocation = await ownedRegistry.pinInboxLocation(join(storageRoot, "inbox"));
      if (current !== generation) throw new Error("Events session replaced");
      ownedProtocol = registerMcpProtocol(pi, EVENTS_COORDINATOR_PROTOCOL); protocol = ownedProtocol;
      const registration = ownedProtocol;
      value = new EventsCoordinator({ sessionId: ctx.sessionManager.getSessionId(), registry: ownedRegistry,
        // Preserve existing session inboxes. Legacy immutable files fail closed
        // with a migration error rather than silently losing pending records.
        inbox: new DurableWebhookInbox(inboxLocation === "session" ? join(directory(ctx), "inbox") : join(storageRoot, "inbox")),
        connect: server => registration.connect(server), ...(options.webhook ? { webhook: options.webhook } : {}),
        onPending: () => current === generation && coordinator === value ? bridge.notify() : undefined,
        onStatus: status => {
          if (current !== generation || coordinator !== value) return;
          const payload: McpEventsStatusSignal = Object.freeze({ version: 1, sessionId: ctx.sessionManager.getSessionId(), ...status });
          pi.events.emit(MCP_EVENTS_STATUS_EVENT, payload);
        },
      });
      coordinator = value;
      await value.restore();
      if (current !== generation) throw new Error("Events session replaced");
      return value;
      }
      catch (error) {
        await value?.close(); if (coordinator === value) coordinator = undefined;
        await ownedRegistry.close(); if (registry === ownedRegistry) registry = undefined;
        ownedProtocol?.dispose(); if (protocol === ownedProtocol) protocol = undefined;
        throw error;
      }
    })().finally(() => { if (current === generation) initializing = undefined; });
    return initializing;
  };
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    const pendingReset = reset(), current = generation;
    await pendingReset;
    if (current !== generation) return;
    // Fresh sessions remain lazy; existing sessions resume their durable intent.
    try { await access(join(directory(ctx), "subscriptions.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (current !== generation) return;
    await ensure(ctx);
  });
  pi.on("session_shutdown", async () => { context = undefined; await reset(); });
  pi.registerTool({ name: "mcp_events", label: "MCP Events",
    description: "Discover event types, subscribe using auto/poll/push/webhook delivery, list durable session subscriptions, unsubscribe, or rotate a generated webhook signing key. Accepted events wake this Pi session. Webhook requires an operator-configured HTTPS receiver.",
    parameters: Type.Object({ action: Type.Union((["catalog", "subscribe", "list", "unsubscribe", "rotate_secret"] as const).map(value => Type.Literal(value))),
      server: Type.Optional(Type.String({ minLength: 1 })), name: Type.Optional(Type.String({ minLength: 1 })),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())), subscription_id: Type.Optional(Type.String()),
      delivery: Type.Optional(Type.Union((["auto", "poll", "push", "webhook"] as const).map(value => Type.Literal(value)))),
      cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])), maxAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
      ttlMs: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    }),
    async execute(_id, args, signal, _update, ctx) {
      try {
        signal?.throwIfAborted();
        const value = await ensure(ctx);
        let result: unknown;
        switch (args.action) {
          case "catalog":
            if (!args.server) throw new Error("Server is required");
            result = await value.catalog(args.server, signal); break;
          case "subscribe":
            if (!args.server || !args.name) throw new Error("Server and event name are required");
            result = await value.subscribe({ server: args.server, name: args.name,
              ...(args.arguments === undefined ? {} : { arguments: args.arguments }),
              ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
              ...(args.maxAgeMs === undefined ? {} : { maxAgeMs: args.maxAgeMs }),
              ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }),
            }, signal); break;
          case "list": result = value.list().filter(row => !args.server || row.server === args.server); break;
          case "unsubscribe":
            if (!args.subscription_id) throw new Error("subscription_id is required");
            await value.unsubscribe(args.subscription_id); result = { stopped: true }; break;
          case "rotate_secret":
            if (!args.subscription_id) throw new Error("subscription_id is required");
            result = await value.rotateSecret(args.subscription_id, signal); break;
          default: throw new Error("Unknown Events action");
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { action: args.action } };
      } catch {
        // Transport/server/filesystem messages can contain private callback
        // URLs or credentials. Do not copy those into the model context.
        return { content: [{ type: "text" as const,
          text: "MCP Events request failed. Check the configured server, requested delivery mode and session ownership." }],
          details: { error: "mcp_events_failed" }, isError: true };
      }
    },
  });
}
