import { resolve } from "node:path";
import { runNativeCodemodeApps } from "../__tests__/fixtures/native-codemode-apps.ts";

const evidence = resolve("../verification-evidence", `live-codemode-apps-${new Date().toISOString().replaceAll(":", "-")}`);
console.log(JSON.stringify(await runNativeCodemodeApps("gemini", evidence)));
