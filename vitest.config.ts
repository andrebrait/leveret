import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests shell out to real engines; semgrep fetches registry
    // rulesets over the network. The 5s default flakes on a slow fetch.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
