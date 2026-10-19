import type { ServerDefinition } from "../../types.ts";

export interface TrustFrame {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: {
    taskId?: string;
    _meta?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
    [key: string]: unknown;
  };
  result?: unknown;
  error?: unknown;
}
export interface TrustInput {
  taskId: string;
  request: { method: string; params: Record<string, unknown> };
  response: { action?: string; content?: unknown; [key: string]: unknown };
}
export interface TrustTask {
  id: string;
  kind: string;
  done: boolean;
  started: boolean;
  polls: number;
  resultRequests: number;
  response?: TrustInput["response"];
  flight?: Promise<void>;
}
export function startTaskTrustServer(options?: {
  era?: "modern" | "legacy";
  correlation?: "valid" | "missing" | "malformed" | "cross-task";
  requireResult?: boolean;
  peerTimeoutMs?: number;
  samplingMaxTokens?: number;
}): Promise<{
  era: "modern" | "legacy";
  url: string;
  definition: ServerDefinition;
  wire: Array<{ direction: "client" | "server"; frame: TrustFrame }>;
  inputs: TrustInput[];
  tasks: Map<string, TrustTask>;
  violations: string[];
  report(): { schemaVersion: number; protocolEra: "modern" | "legacy"; taskCount: number;
    tasks: Array<{ taskId: string; kind: string; polls: number; resultRequests: number;
      terminal: boolean; inputAction?: string; samplingReturned: boolean }>;
    clientMethods: string[]; violations: string[] };
  close(): Promise<void>;
}>;
