import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Client-side unit tests.
 *
 * Added for the DOM reader and the action gate: the gate decides whether an
 * agent may press Send on someone's page, and that is not a thing to ship on
 * the strength of having read it carefully. The agent side already has pytest
 * for the same reason.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["client/src/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "client/src") },
  },
});
