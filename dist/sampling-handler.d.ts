import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/client";
import { type TaskReceiverBinding } from "@modelcontextprotocol/ext-tasks/receiver";
import { type CreateMessageRequest, type CreateMessageResultWithTools } from "@modelcontextprotocol/client";
export type SamplingUIContext = Pick<ExtensionUIContext, "confirm"> & Partial<Pick<ExtensionUIContext, "select" | "editor">>;
export type SamplingModelRegistry = Pick<ModelRegistry, "getAvailable" | "complete">;
export interface SamplingHandlerOptions {
    serverName: string;
    autoApprove: boolean;
    ui?: SamplingUIContext;
    modelRegistry: SamplingModelRegistry;
    getCurrentModel: () => Model<Api> | undefined;
    getSignal: () => AbortSignal | undefined;
    /** Return only session messages authorized for this server and scope; undefined denies inclusion. */
    getContext?: (serverName: string, includeContext: "thisServer" | "allServers", signal?: AbortSignal) => Message[] | undefined | Promise<Message[] | undefined>;
}
export type ServerSamplingConfig = Omit<SamplingHandlerOptions, "serverName">;
export declare function registerSamplingHandler(client: Client, options: SamplingHandlerOptions): void;
/** Install after the plain handler, before connecting; host advertises capabilities and closes the binding. */
export declare function registerSamplingTaskReceiver(client: Client, options: SamplingHandlerOptions): TaskReceiverBinding;
export declare function handleSamplingRequest(options: SamplingHandlerOptions, request: CreateMessageRequest, requestSignal?: AbortSignal): Promise<CreateMessageResultWithTools>;
