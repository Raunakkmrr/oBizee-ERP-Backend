import { sql } from "drizzle-orm";

import { adminDb } from "./client.ts";

/**
 * Whether the things the live tests need are actually there.
 *
 * **Why this is one module and not five guards.** The five live test files grew
 * three different ideas of "live" between them: two probed the API, one probed
 * the database, and two asked `Boolean(process.env.DATABASE_URL)` — which tests
 * whether somebody set a string, not whether a database answers. That last one
 * is the dangerous shape. Point it at a URL that resolves to nothing and the
 * suite does not skip; it runs and fails on a connection error, and the report
 * says the numbering series is broken when the truth is that nobody was
 * listening.
 *
 * It also made continuous integration impossible to set up honestly. The
 * driver refuses to load without a connection string — deliberately, so a
 * production process cannot quietly write to a laptop — so CI has to provide
 * one, and providing one used to switch on tests that could not pass.
 *
 * Probed once, at module load, and shared. A probe per file would be five round
 * trips before a single assertion runs.
 */
const API = process.env.API_URL ?? "http://localhost:8787";

/** A database that answers, rather than a string that exists. */
export const databaseIsLive: boolean = await adminDb
  .execute(sql`select 1`)
  .then(() => true)
  .catch(() => false);

/** An API listening, which several suites drive over HTTP rather than in-process. */
export const apiIsLive: boolean = await fetch(`${API}/health`)
  .then((response) => response.ok)
  .catch(() => false);

export { API as API_BASE };
