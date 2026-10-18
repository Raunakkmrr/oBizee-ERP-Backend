import { describe, expect, it } from "vitest";
import { cohortAllowed, cohortEntitlements, SHIPPED_MODULES } from "./entitlements.ts";
describe("one temporary server policy", () => {
  it("grants only shipped modules without a role, plan, browser toggle or stale token claim", () => {
    expect(cohortEntitlements()).toEqual({ policy: "ERP-PLATFORM-005A", universal: true, modules: ["overview","customers"] });
    expect(SHIPPED_MODULES.every(cohortAllowed)).toBe(true);
    const grant = cohortEntitlements(); grant.modules.length = 0;
    expect(cohortAllowed("customers")).toBe(true);
  });
});
