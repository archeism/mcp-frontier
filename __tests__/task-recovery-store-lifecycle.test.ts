import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ closes: 0, createFile: true }));
vi.mock("node:module", async importOriginal => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: (url: string | URL) => {
    const require = actual.createRequire(url);
    return (name: string) => name === "node:sqlite" ? { DatabaseSync: class {
      constructor(path: string) { if (native.createFile) writeFileSync(path, ""); }
      exec() { throw new Error("Fixture SQLite initialization failure"); }
      close() { native.closes++; }
    } } : require(name);
  } };
});
import { FileTaskRecoveryStore } from "../task-recovery-store.ts";

for (const stage of ["permissions", "schema"] as const) it(`closes the native database when ${stage} initialization fails`, () => {
  const root = mkdtempSync(join(tmpdir(), "task-store-constructor-"));
  native.closes = 0; native.createFile = stage === "schema";
  try {
    expect(() => new FileTaskRecoveryStore({ sessionId: "session", sessionFile: join(root, "session.jsonl") })).toThrow();
    expect(native.closes).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
