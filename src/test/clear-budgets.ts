/**
 * Hand back the sign-in budgets this suite is about to spend.
 *
 * Several tests here present a wrong password, a garbage refresh token or a
 * revoked one **on purpose** — that is what they are testing. Those are real
 * failures and the limiter is right to count them. But they all come from one
 * address, and so does the Playwright suite next door, so running both inside
 * one fifteen-minute window reaches the budget and the next test to ask for a
 * token gets a 429 where it expected a 401.
 *
 * That reads as the product being broken rather than the limiter working, and
 * it cost an afternoon the first time it happened. The E2E suite already does
 * this in its global setup; this is the same courtesy for the API suite.
 *
 * Only the keys these tests touch, and only ever in development.
 */
import { sql } from "drizzle-orm";

import { adminDb } from "../db/client.ts";

const KEYS = [
  "pw:account:manish@shakticooling.test",
  "pw:account:sunita@vermacooling.test",
  "pw:ip:unknown",
  "pw:ip:127.0.0.1",
  "pw:ip:::1",
  "otp:req:phone:919820012345",
  "otp:req:ip:unknown",
  "otp:req:ip:127.0.0.1",
  "otp:req:ip:::1",
  "otp:verify:phone:919820012345",
  "otp:verify:ip:127.0.0.1",
  "otp:verify:ip:::1",
  /*
    The one that actually bit. Every cold page load exchanges the cookie, so
    the Playwright suite spends this fast — and the deliberate failures here
    are not refunded, correctly.
  */
  "refresh:ip:unknown",
  "refresh:ip:127.0.0.1",
  "refresh:ip:::1",
];

export default async function clearBudgets(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  if (!process.env.DATABASE_URL) return;

  try {
    for (const key of KEYS) {
      await adminDb.execute(sql`select clear_rate_limit(${key})`);
    }
  } catch {
    /*
      A database that cannot be reached is the `skipIf` case for every live
      test in this suite; failing setup here would turn "no database" from a
      skip into a red run.
    */
  }
}
