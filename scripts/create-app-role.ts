/**
 * Give `app_runtime` a password, and print the connection string once.
 *
 * The role itself is created by migration 0010 without the right to log in,
 * because a migration is a file in a repository and a password must never be.
 * This is the one step an operator runs by hand, per environment.
 *
 *   node --experimental-strip-types --env-file=.env scripts/create-app-role.ts
 *
 * Re-running rotates the password. Existing HTTP requests are unaffected — each
 * one authenticates afresh — but `APP_DATABASE_URL` has to be updated wherever
 * it is configured before the next deploy, or the API cannot connect.
 */
import { randomBytes } from "node:crypto";

import { neon } from "@neondatabase/serverless";

const owner = process.env.DATABASE_URL;
if (!owner) throw new Error("DATABASE_URL is not set");

const sql = neon(owner);

const [role] = await sql`SELECT rolname FROM pg_roles WHERE rolname = 'app_runtime'`;
if (!role) {
  throw new Error("app_runtime does not exist — run the migrations first (npm run db:migrate)");
}

const password = randomBytes(24).toString("base64url");

/*
  Not parameterised, because ALTER ROLE takes a literal and not a bind. The
  value is 24 bytes of base64url from the system CSPRNG — no quote can appear
  in it — so there is nothing here for a quote to escape.
*/
await sql.query(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${password}'`);

/*
  BYPASSRLS would make every policy in 0010 decoration. Asserted rather than
  assumed: this is the single property the whole tenancy boundary rests on.
*/
const [check] = await sql`
  SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_runtime'`;
if (check?.rolbypassrls || check?.rolsuper) {
  throw new Error("app_runtime can bypass row-level security — refusing to hand out a password");
}

const url = new URL(owner);
url.username = "app_runtime";
url.password = password;

console.log("\nAdd this to the environment. It is not stored anywhere else.\n");
console.log(`APP_DATABASE_URL=${url.toString()}\n`);
process.exit(0);
