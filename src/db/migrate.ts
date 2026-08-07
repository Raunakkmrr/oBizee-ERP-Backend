import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";

/**
 * Apply every migration not yet applied, in order.
 *
 * Hand-rolled rather than `drizzle-kit migrate` for one reason: the guards in
 * `0001_guards.sql` are plpgsql functions with `$$` bodies, and the generic
 * runner splits statements on `;` — which cuts a function in half. The
 * `--> statement-breakpoint` marker drizzle already writes is the correct split
 * point, so this uses that.
 *
 * Applied migrations are recorded with a hash of their contents. Re-running is
 * a no-op; **editing a migration that has already run is an error**, because
 * the database and the file would then disagree and nobody would know which was
 * true. Add a new migration instead.
 */
const sql = neon(process.env.DATABASE_URL ?? "");

await sql`
  CREATE TABLE IF NOT EXISTS _applied_migrations (
    tag         text PRIMARY KEY,
    hash        text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

const applied = new Map(
  (await sql`select tag, hash from _applied_migrations`).map(
    (r) => [r.tag as string, r.hash as string] as const,
  ),
);

const dir = new URL("../../drizzle/", import.meta.url).pathname;
const files = readdirSync(dir)
  // `._*` is skipped because this repo sits on an exFAT volume, where macOS
  // writes an AppleDouble sibling for every file — and `._0001_guards.sql`
  // ends in `.sql` too. Same cause as the notes in db-generate.sh and
  // vitest.config.ts.
  .filter((f) => f.endsWith(".sql") && !f.startsWith("._"))
  .sort();

let ran = 0;
for (const file of files) {
  const tag = file.replace(/\.sql$/, "");
  const body = readFileSync(dir + file, "utf8");
  const hash = createHash("sha256").update(body).digest("hex");

  const previous = applied.get(tag);
  if (previous === hash) {
    console.log(`${tag}: already applied`);
    continue;
  }
  if (previous && previous !== hash) {
    throw new Error(
      `${tag} has changed since it was applied. A migration is a record of ` +
        `what the database did, not a file to edit — add a new one instead.`,
    );
  }

  const statements = body
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  process.stdout.write(`${tag}: ${statements.length} statements … `);
  for (const statement of statements) {
    await sql.query(statement);
  }
  await sql`insert into _applied_migrations (tag, hash) values (${tag}, ${hash})`;
  process.stdout.write("ok\n");
  ran += 1;
}

console.log(ran === 0 ? "nothing to apply" : `applied ${ran}`);
