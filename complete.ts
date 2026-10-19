import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { getAgentPath } from "./agent-dir.ts";
import { createMcpAdapter, type McpAdapterOptions } from "./index.ts";
import { installSkills, createSkillsResourceReadPolicy } from "./mcp-skills.ts";
import { installCore } from "./mcp-core.ts";
import { installCanonicalEvents, type EventsOptions } from "./mcp-events.ts";
import { FileTaskRecoveryStore } from "./task-recovery-store.ts";

export * from "./index.ts";
export { WebhookReceiver } from "./mcp-events-webhook.ts";
export { startWebhookListener, type WebhookListenerOptions } from "./mcp-events-listener.ts";
export type { EventsOptions, EventPresentationPolicy } from "./mcp-events.ts";
export { MCP_EVENTS_STATUS_EVENT, type McpEventsStatusSignal } from "./mcp-events.ts";
export { FileTaskRecoveryStore, type FileTaskRecoveryStoreOptions, type TaskRecoveryScope, type TaskRecoveryStore } from "./task-recovery-store.ts";

export interface CompleteMcpClientOptions extends McpAdapterOptions { events?: EventsOptions }
export function createCompleteMcpClient(options: CompleteMcpClientOptions = {}) {
  return (pi: ExtensionAPI) => {
    const taskDirectory = getAgentPath("mcp-task-recovery");
    const resourceReadPolicy = createSkillsResourceReadPolicy();
    const operatorScope = new AsyncLocalStorage<{ server: string; uri: string }>();
    const operatorPolicy = options.resourceReadPolicy;
    const composedPolicy: NonNullable<McpAdapterOptions["resourceReadPolicy"]> = (server, uri, read, signal) =>
      resourceReadPolicy.readResource(server, uri, () => {
        const active = operatorScope.getStore();
        if (!operatorPolicy || (active?.server === server && active.uri === uri)) return read();
        // SDK readResource may enter request internally. One logical read gets
        // one operator decision; Skills still verifies the returned bytes.
        return operatorScope.run({ server, uri }, () => operatorPolicy(server, uri, read, signal));
      }, signal);
    createMcpAdapter({ ...options, resourceReadPolicy: composedPolicy,
      createTaskRecoveryStore: options.createTaskRecoveryStore ?? (scope =>
        // Never bypass a pre-existing journal: that could repeat an uncertain
        // original effect. New sessions share one aggregate admission budget.
        existsSync(scope.sessionFile + ".mcp-tasks/recovery.sqlite")
          ? new FileTaskRecoveryStore(scope)
          : new FileTaskRecoveryStore(scope, { directory: taskDirectory })),
    })(pi);
    installSkills(pi, { resourceReadPolicy });
    installCore(pi);
    installCanonicalEvents(pi, options.events);
  };
}
export default createCompleteMcpClient();
