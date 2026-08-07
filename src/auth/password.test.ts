import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.ts";

describe("password hashing", () => {
  it("verifies the right password and refuses the wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(stored, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(stored, "correct horse battery stapl")).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same")).toBe(true);
    expect(await verifyPassword(b, "same")).toBe(true);
  });

  it("stores its parameters, so the cost can be raised later", async () => {
    // Verify with what the record says, re-hash with the current cost — a
    // migration on next sign-in rather than a flag day.
    const stored = await hashPassword("x");
    const [scheme, n, r, p] = stored.split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(n)).toBe(1 << 17);
    expect([Number(r), Number(p)]).toEqual([8, 1]);
  });

  it("verifies against a record made with a weaker cost", async () => {
    // What an upgrade looks like: an old row must still let its owner in.
    const weak = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2E$" +
      (await import("node:crypto")).scryptSync("x", Buffer.from("c2FsdHNhbHRzYWx0c2E", "base64url"), 64, { N: 16384, r: 8, p: 1 }).toString("base64url");
    expect(await verifyPassword(weak, "x")).toBe(true);
    expect(await verifyPassword(weak, "y")).toBe(false);
  });

  it("treats a corrupt record as a failed sign-in, not a crash", async () => {
    for (const bad of ["", "nonsense", "scrypt$a$b$c$d$e", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPassword(bad, "x"), bad).toBe(false);
    }
  });

  it("normalises unicode, so the same typed password matches", async () => {
    // "é" composed vs decomposed are different bytes and the same password.
    const stored = await hashPassword("café");
    expect(await verifyPassword(stored, "café")).toBe(true);
  });
});
