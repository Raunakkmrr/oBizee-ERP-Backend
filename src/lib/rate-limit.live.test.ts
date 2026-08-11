/**
 * The sign-in doors, under attack.
 *
 * These assertions are the reasons the limiter is shaped the way it is. Each
 * one is a decision that could reasonably have gone the other way, so each is
 * written down rather than left to the reader of the SQL.
 *
 * Runs against the real database — a limiter tested against a fake is a test
 * of the fake.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { adminDb as db } from "../db/client.ts";
import { databaseIsLive } from "../db/live.ts";
import { callerIp, refund } from "./rate-limit.ts";

/* A database that answers, not a string that exists — see db/live.ts. */
const live = databaseIsLive;

/** A key nothing else touches, so the budget starts full. */
function freshKey(name: string): string {
  return `test:${name}:${process.pid}:${performance.now()}`;
}

async function consumeRaw(key: string, max: number, windowSeconds = 900) {
  const result = await db.execute(
    sql`select * from consume_rate_limit(${key}, ${max}, ${windowSeconds})`,
  );
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return rows[0] as { allowed: boolean; retry_after: number };
}

describe.skipIf(!live)("consume_rate_limit", () => {
  it("allows exactly the budget, then refuses", async () => {
    const key = freshKey("sequential");
    const verdicts = [];
    for (let i = 0; i < 7; i += 1) verdicts.push((await consumeRaw(key, 5)).allowed);

    expect(verdicts).toEqual([true, true, true, true, true, false, false]);
  });

  it("does not undercount under concurrency", async () => {
    /*
      The assertion the whole design rests on. Guessing is done concurrently,
      so a limiter that reads-then-increments lets twenty simultaneous attempts
      through on a budget of five — and a limiter that only holds when requests
      are polite is not a limiter.
    */
    const key = freshKey("concurrent");
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => consumeRaw(key, 5)),
    );

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
  });

  it("reports a truthful wait rather than a guess", async () => {
    const key = freshKey("retry");
    await consumeRaw(key, 1, 60);
    const refused = await consumeRaw(key, 1, 60);

    expect(refused.allowed).toBe(false);
    // Within the window, and never zero — a Retry-After of 0 invites an
    // immediate retry, which is the opposite of what was asked for.
    expect(refused.retry_after).toBeGreaterThan(0);
    expect(refused.retry_after).toBeLessThanOrEqual(60);
  });

  it("reopens when the window closes", async () => {
    const key = freshKey("window");
    // A one-second window, so the test can actually wait it out.
    expect((await consumeRaw(key, 1, 1)).allowed).toBe(true);
    expect((await consumeRaw(key, 1, 1)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect((await consumeRaw(key, 1, 1)).allowed).toBe(true);
  });

  it("keeps separate keys independent", async () => {
    const a = freshKey("a");
    const b = freshKey("b");
    await consumeRaw(a, 1);
    await consumeRaw(a, 1);

    // Exhausting one account's budget must not touch anybody else's.
    expect((await consumeRaw(b, 1)).allowed).toBe(true);
  });

  it("gives a hit back, so an office does not lock itself out by working", async () => {
    /*
      The case this is about: a dozen people behind one NAT address, all
      signing in successfully on a Monday morning. Each spends a hit on the
      shared address budget, and before the refund the twenty-first person —
      and everybody after — was refused by a limiter counting attacks that had
      not happened.

      Spends the whole budget, refunds one, and asserts exactly one more gets
      through. A refund that cleared the key instead would let far more.
    */
    const key = freshKey("refund");
    const budget = 3;

    // Twelve people, one address, every one of them getting in. Before the
    // refund the fourth was refused and so was everybody after.
    for (let person = 1; person <= 12; person += 1) {
      expect(
        (await consumeRaw(key, budget)).allowed,
        `person ${person} was locked out by colleagues who had signed in successfully`,
      ).toBe(true);
      await refund(key);
    }

    /*
      And the budget still bites when the attempts are failures — which is the
      half a plain `clear` would have thrown away.
    */
    for (let i = 0; i < budget; i += 1) expect((await consumeRaw(key, budget)).allowed).toBe(true);
    expect((await consumeRaw(key, budget)).allowed, "failures no longer count").toBe(false);
  });

  it("forgets a key when told to", async () => {
    const key = freshKey("clear");
    await consumeRaw(key, 1);
    expect((await consumeRaw(key, 1)).allowed).toBe(false);

    await db.execute(sql`select clear_rate_limit(${key})`);

    // What a successful sign-in does: only failures accumulate.
    expect((await consumeRaw(key, 1)).allowed).toBe(true);
  });
});

describe("callerIp", () => {
  const withHeaders = (headers: Record<string, string>) =>
    ({ req: { header: (name: string) => headers[name.toLowerCase()] }, env: {} }) as never;

  it("takes the nearest hop, not the client's own claim", () => {
    /*
      `x-forwarded-for` is a list a caller can prepend to. Reading the *first*
      entry would let anyone choose their own rate-limit bucket by sending a
      header — worse than not limiting by IP at all, because it looks like it
      works.
    */
    const ip = callerIp(withHeaders({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }));
    expect(ip).toBe("203.0.113.9");
  });

  it("falls back rather than throwing when nothing identifies the caller", () => {
    expect(callerIp(withHeaders({}))).toBe("unknown");
  });
});
