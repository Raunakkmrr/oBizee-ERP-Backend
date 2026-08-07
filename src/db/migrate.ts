import { readFileSync, readdirSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

/**
 * Apply every migration in order.
 *
 * Hand-rolled rather than `drizzle-kit migrate` because the guards in
 * `0001_guards.sql` are functions and triggers with `$$` bodies, and the
 * generic runner splits on `;` — which cuts a plpgsql function in half. The
 * `--> statement-breakpoint` marker drizzle already writes is the correct
 * split point, so this uses that.
 */
const sql = neon(process.env.DATABASE_URL ?? "");

const dir = new URL("../../drizzle/", import.meta.url).pathname;
const files = readdirSync(dir)
  // `._*` is skipped because this repo sits on an exFAT volume, where macOS
  // writes an AppleDouble sibling for every file — and `._0001_guards.sql`
  // ends in `.sql` too. Same root cause as the notes in db-generate.sh and
  // vitest.config.ts.
  .filter((f) => f.endsWith(".sql") && !f.startsWith("._"))
  .sort();

for (const file of files) {
  const body = readFileSync(dir + file, "utf8");
  const statements = body
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  process.stdout.write(`${file}: ${statements.length} statements … `);
  for (const statement of statements) {
    await sql.query(statement);
  }
  process.stdout.write("ok\n");
}

console.log("migrations applied");
