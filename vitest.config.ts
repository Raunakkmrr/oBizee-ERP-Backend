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
  },
});
