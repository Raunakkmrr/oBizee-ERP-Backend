import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The two copies of the permission table must be identical.
 *
 * `obez-erp-web/src/lib/roles.ts` is a mirror of `src/auth/roles.ts` so the
 * interface can grey out a control before it is clicked. If they drift, the
 * browser hides a button the API allows — or worse, shows one the API refuses,
 * which is a defect nobody sees until a coordinator is told "no" by a screen
 * that offered it.
 *
 * Skipped when the web repo is not checked out beside this one. That is a real
 * hole and the reason it exists is honest: these are separate repositories, and
 * a cross-repo check has nowhere else to live until they share a pipeline.
 */
const WEB_COPY = new URL(
  "../../../obez-erp-web/src/lib/roles.ts",
  import.meta.url,
).pathname;

const API_COPY = new URL("./roles.ts", import.meta.url).pathname;

/** Everything above the first export is prose about which copy is authoritative. */
function body(source: string): string {
  const start = source.indexOf("/** The six built-in roles");
  return start === -1 ? source : source.slice(start);
}

describe("the permission table has exactly one definition", () => {
  it.skipIf(!existsSync(WEB_COPY))(
    "matches the web app's mirror byte for byte",
    () => {
      const api = body(readFileSync(API_COPY, "utf8"));
      const web = body(readFileSync(WEB_COPY, "utf8"));
      expect(api).toBe(web);
    },
  );

  it("is present regardless, so a missing sibling cannot silently pass", () => {
    expect(existsSync(API_COPY)).toBe(true);
  });
});
