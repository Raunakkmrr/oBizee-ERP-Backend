import { describe, expect, it } from "vitest";
import { can } from "./roles.ts";

/**
 * The collision that made this file worth testing.
 *
 * Marketing and technician both have a `senior` rung, and the grants table was
 * keyed on the level string alone — so a senior technician inherited the senior
 * marketer's commercial permissions.
 */
describe("a level grants only within its own role", () => {
  it("gives a senior marketer pricing and quoting", () => {
    expect(can("marketing", "price:view_selling", undefined, "senior")).toBe(true);
    expect(can("marketing", "quote:write", undefined, "senior")).toBe(true);
  });

  it("gives a senior technician neither", () => {
    // FR-1302 is an anti-freelancing control. A technician who can see the
    // margin can quote around the firm — the bug handed it to exactly the
    // person the rule exists to keep it from.
    expect(can("technician", "price:view_selling", undefined, "senior")).toBe(false);
    expect(can("technician", "quote:write", undefined, "senior")).toBe(false);
    expect(can("technician", "contract:write", undefined, "senior")).toBe(false);
  });

  it("still refuses a marketing level that grants nothing", () => {
    expect(can("marketing", "price:view_selling", undefined, "support")).toBe(false);
  });

  it("is unaffected by a level the role does not have", () => {
    expect(can("technician", "price:view_selling", undefined, "leads")).toBe(false);
  });

  it("leaves base role permissions alone", () => {
    expect(can("technician", "job:read_own", undefined, "senior")).toBe(true);
    expect(can("technician", "job:read", undefined, "senior")).toBe(false);
  });
});
