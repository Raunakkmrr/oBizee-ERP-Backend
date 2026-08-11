/**
 * A backup of this database, taken with nothing but Node.
 *
 *   node --experimental-strip-types --env-file=.env src/db/backup.ts
 *   BACKUP_DIR=/somewhere node … src/db/backup.ts
 *
 * **Why this exists next to `scripts/backup-local.sh`.** That one shells out to
 * `pg_dump` in a container and is the better artefact — a real dump, restorable
 * table-by-table by tooling that has been correct for thirty years. It needs a
 * container runtime. This one needs the driver the API already uses, so it
 * works on any machine that can run the API at all, which today is the
 * difference between having backups and planning to.
 *
 * **What it is and is not.** Every row of every table, as gzipped NDJSON, plus
 * a manifest with counts and a digest per table. It does *not* carry the
 * schema — the twelve migrations in `drizzle/` are the schema, they refuse to
 * run out of order, and `_applied_migrations` is captured here so a restore can
 * prove the two agree. Data and DDL in separate places is a real trade: a dump
 * is one file, this is a directory and a repository.
 *
 * It reads through `adminDb`, deliberately. `app_runtime` cannot bypass
 * row-level security, so the same code pointed at it would write a complete,
 * well-formed, entirely empty archive — measured: as `app_runtime`,
 * `select count(*) from customers` returns 0 where the table holds 8. The check
 * below refuses rather than trusting that nobody will wire it up wrongly.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { sql } from "drizzle-orm";

import { adminDb as db } from "./client.ts";

const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(homedir(), "obizee-backups");

/** Postgres types the JSON round-trip would otherwise quietly change. */
function serialise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  /*
    `bigint` is what the money columns come back as, and `JSON.stringify` throws
    on it rather than silently truncating — which is the correct behaviour and
    the reason this is here. Written as a string so no precision is lost on the
    way back in; a paisa figure that survives a backup as a float is not a
    backup of a ledger.
  */
  if (typeof value === "bigint") return value.toString();
  return value;
}

async function main(): Promise<number> {
  const [who] = (
    await db.execute(sql`
      select current_user as role,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass`)
  ).rows as { role: string; bypass: boolean }[];

  if (!who?.bypass) {
    console.error(
      `${who?.role} cannot see past row-level security. A backup taken with it would be ` +
        `well-formed and empty. Use DATABASE_URL, not APP_DATABASE_URL.`,
    );
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(BACKUP_DIR, stamp);
  await mkdir(dir, { recursive: true });
  console.log(`${who.role} → ${dir}\n`);

  const tables = (
    await db.execute(sql`
      select tablename from pg_tables where schemaname = 'public' order by tablename`)
  ).rows as { tablename: string }[];

  const manifest: Record<string, { rows: number; bytes: number; sha256: string }> = {};
  let total = 0;

  for (const { tablename } of tables) {
    const rows = (await db.execute(sql.raw(`select * from "${tablename}"`))).rows as Record<
      string,
      unknown
    >[];

    /*
      NDJSON rather than one array: a truncated file loses the rows after the
      break and not the whole table, and a 200 MB table can be read a line at a
      time by a restore that has no business holding it all in memory.
    */
    const body = rows
      .map((row) =>
        JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, serialise(v)]))),
      )
      .join("\n");

    const gz = gzipSync(Buffer.from(body, "utf8"));
    await writeFile(path.join(dir, `${tablename}.ndjson.gz`), gz);

    manifest[tablename] = {
      rows: rows.length,
      bytes: gz.byteLength,
      sha256: createHash("sha256").update(gz).digest("hex"),
    };
    total += rows.length;
    if (rows.length) console.log(`  ${tablename.padEnd(24)} ${String(rows.length).padStart(6)} rows`);
  }

  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        role: who.role,
        /*
          The schema this data belongs to. A restore that applies a different
          set of migrations produces a database that loads and is wrong, and
          this is what lets it refuse instead.
        */
        migrations: (await db.execute(sql`select tag from _applied_migrations order by tag`)).rows,
        tables: manifest,
      },
      null,
      2,
    ),
  );

  const bytes = Object.values(manifest).reduce((sum, t) => sum + t.bytes, 0);
  console.log(
    `\n${total} rows across ${tables.length} tables, ${(bytes / 1024).toFixed(0)} KB compressed`,
  );
  return 0;
}

process.exit(await main());
