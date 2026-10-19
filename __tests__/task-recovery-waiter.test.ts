import { expect, it } from "vitest";
import { TaskRecoveryBinding, type TaskRecoveryCall, type TaskRecoveryRecord } from "../task-recovery-store.ts";

it("cancelling one pre-registration input waiter does not orphan another waiter for the same task", async () => {
  const binding = new TaskRecoveryBinding({ read: async () => undefined, compareAndSet: async () => true });
  const reference = { endpointId: "endpoint", taskId: "task", generation: "v2" as const, originalOperation: "tools/call" as const };
  let record: TaskRecoveryRecord = { revision: 1, endpointId: "endpoint", name: "work", argumentsHash: "0".repeat(64), phase: "task", reference, inputs: {} };
  const call: TaskRecoveryCall = { record: () => record, update: async change => { record = change(record); }, controller: new AbortController() };
  const a = new AbortController(), b = new AbortController();
  const first = binding.input("endpoint", "task", "input-a", { kind: "roots", params: {} }, a.signal, async () => ({ roots: [] }));
  const second = binding.input("endpoint", "task", "input-b", { kind: "roots", params: {} }, b.signal, async () => ({ roots: [] }));
  const cancelled = expect(first).rejects.toThrow("Only the first waiter cancelled");
  a.abort(new Error("Only the first waiter cancelled")); await cancelled;
  binding.register(reference, call);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Surviving waiter was orphaned")), 200); });
    expect(await Promise.race([second, timeout])).toEqual({ roots: [] });
  } finally { clearTimeout(timer); b.abort(); }
});
