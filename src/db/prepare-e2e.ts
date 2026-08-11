/**
 * Put this database into the state the web app's end-to-end suite asserts
 * against.
 *
 *   npm run e2e:prepare
 *
 * **Why it lives here.** It used to live in the web repository, which reached
 * across the filesystem into `../obez-erp-api`, ran these scripts with this
 * repository's `.env`, and started this server. That made the frontend
 * untestable unless the backend happened to be checked out beside it with
 * working database credentials — two repositories that could only be used as
 * one.
 *
 * A repository should own its own fixtures. The web suite now talks to whatever
 * API answers at `API_URL` and knows nothing about where its source lives or
 * what it is called.
 *
 * Everything here is additive or idempotent: masters are created only when
 * missing, the day is replaced, drafts are swept, and the stock ledger is
 * append-only and cannot be rebuilt at all.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { sql } from "drizzle-orm";

import { adminDb as db } from "./client.ts";

if (process.env.NODE_ENV === "production") {
  throw new Error("prepare-e2e seeds fixture data and will not run in production");
}

function run(script: string): void {
  const file = new URL(script, import.meta.url).pathname;
  if (!existsSync(file)) throw new Error(`Cannot find ${file}`);
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--env-file-if-exists=.env", `src/db/${script}`],
    { cwd: new URL("../../", import.meta.url).pathname, stdio: "inherit" },
  );
}

/**
 * Hand back the budgets the suite is about to spend.
 *
 * One test signs in with the wrong password on purpose, and wrong sign-ins are
 * counted — five in fifteen minutes locks the seeded owner out and every later
 * test then fails as "too many attempts", which reads as the product being
 * broken rather than the limiter working.
 *
 * The refresh budget is here for a different reason: every `page.goto` is a
 * cold document, and a cold document exchanges the cookie for an access token.
 * A suite of thirty-five tests spends that faster than any person could. It is
 * refunded on success now, so this only covers the failures the suite causes
 * deliberately.
 */
const BUDGETS = [
  "pw:account:manish@shakticooling.test",
  "pw:ip:unknown",
  "pw:ip:127.0.0.1",
  "pw:ip:::1",
  "otp:req:phone:919820012345",
  "otp:req:ip:unknown",
  "otp:req:ip:127.0.0.1",
  "otp:req:ip:::1",
  "otp:verify:phone:919820012345",
  "refresh:ip:unknown",
  "refresh:ip:127.0.0.1",
  "refresh:ip:::1",
];

// Masters first: the day fixture hangs jobs off customers and technicians.
run("seed.ts");
run("seed-day.ts");

for (const key of BUDGETS) {
  await db.execute(sql`select clear_rate_limit(${key})`);
}
console.log(`cleared ${BUDGETS.length} attempt budgets`);

/*
  `billing.spec.ts` presses "Bill this", which is the point of it — and the
  draft stays. Forty-nine had piled up on the money screen before anybody
  looked, each one a row a coordinator would have to read past on a screen whose
  job is to show what needs acting on.
*/
run("clear-drafts.ts");

console.log("\nready for the web app's E2E suite");
process.exit(0);
