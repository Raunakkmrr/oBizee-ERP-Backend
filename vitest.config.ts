import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * `._*` is excluded because this repo sits on an exFAT volume, where macOS
     * writes an AppleDouble sibling for every file. Vitest would otherwise
     * collect `._roles.sync.test.ts` as a suite and fail parsing binary.
     * Same root cause as the note in scripts/db-generate.sh.
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
    /**
     * Several tests here fail a sign-in on purpose, and the limiter counts
     * those correctly. Run back to back with the Playwright suite from the same
     * address, the budget runs out and a test expecting 401 gets 429 — which
     * reads as the product being broken rather than the limiter working.
     */
    globalSetup: ["./src/test/clear-budgets.ts"],
  },
});
