import { resolve } from "node:path";
import { expect, it } from "vitest";
import { runNativeCodemodeApps } from "./fixtures/native-codemode-apps.ts";

it("native codemode-only opens the real MCP Apps bridge in Chrome and retains server/auth/approval boundaries", async () => {
  const evidence = resolve("../verification-evidence", `native-codemode-apps-${new Date().toISOString().replaceAll(":", "-")}`);
  expect((await runNativeCodemodeApps("faux", evidence)).passed).toBe(true);
}, 120000);
