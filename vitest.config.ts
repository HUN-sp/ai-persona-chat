import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "evals/**/*.test.ts"],
    // Keep tests hermetic: no test may reach a real service.
    env: { TZ: "UTC" },
    clearMocks: true,
    restoreMocks: true,
  },
});
