import { expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { handleSamplingRequest, type SamplingHandlerOptions } from "../sampling-handler.ts";

const usage: AssistantMessage["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model: Model<Api> = { api: "anthropic-messages", provider: "review", id: "test", name: "test", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: usage.cost };
const answer: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "done" }], usage, stopReason: "stop", timestamp: 1 };

for (const source of ["request", "owner"] as const) {
  for (const phase of ["request approval", "response approval", "context approval"] as const) {
    it(`dismisses the ${phase} callback when ${source} cancels`, async () => {
      const request = new AbortController(), owner = new AbortController();
      let ready!: () => void;
      const opened = new Promise<void>(resolve => { ready = resolve; });
      let dismissed = false;
      let dialogSignal: AbortSignal | undefined;
      const complete = vi.fn(async () => answer);
      let confirmations = 0;
      const confirm: NonNullable<SamplingHandlerOptions["ui"]>["confirm"] = async (_title, _message, options) => {
        confirmations++;
        if (phase === "response approval" && confirmations === 1) return true;
        dialogSignal = options?.signal;
        ready();
        return new Promise<boolean>(resolve => {
          options?.signal?.addEventListener("abort", () => { dismissed = true; resolve(false); }, { once: true });
        });
      };
      const options: SamplingHandlerOptions = {
        serverName: "alpha", autoApprove: phase === "context approval", ui: { confirm },
        modelRegistry: { getAvailable: () => [model], complete },
        getCurrentModel: () => model, getSignal: () => owner.signal,
        getContext: async (_server, _scope, signal) => {
          const approved = await confirm("context", "context", { signal });
          return approved ? [] : undefined;
        },
      };
      const pending = handleSamplingRequest(options, { method: "sampling/createMessage", params: {
        maxTokens: 10, messages: [{ role: "user", content: { type: "text", text: "hello" } }],
        ...(phase === "context approval" ? { includeContext: "thisServer" as const } : {}),
      } }, request.signal);
      const rejected = expect(pending).rejects.toThrow("review cancellation");
      await opened;
      (source === "request" ? request : owner).abort(new Error("review cancellation"));
      await rejected;
      expect(dialogSignal, "the actual dialog callback must receive cancellation").toBeInstanceOf(AbortSignal);
      expect(dialogSignal?.aborted).toBe(true);
      expect(dismissed, "rejecting the outer operation alone leaves a stale dialog").toBe(true);
      expect(complete).toHaveBeenCalledTimes(phase === "response approval" ? 1 : 0);
    });
  }
}
