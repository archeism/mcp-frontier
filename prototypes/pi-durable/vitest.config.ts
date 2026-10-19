import { defineConfig } from "vitest/config";

export default defineConfig({ test: {
  environment: "node",
  include: ["prototypes/pi-durable/*.test.ts"],
  env: { PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory", PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: "1" },
} });
