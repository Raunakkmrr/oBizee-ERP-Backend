import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

/**
 * The database handle.
 *
 * Neon over HTTP rather than a TCP pool: this API is meant to run on
 * serverless compute, where a connection pool per instance exhausts the
 * database's connection limit long before it exhausts anything else. The
 * pooled endpoint in `DATABASE_URL` handles the rest.
 *
 * Refused rather than defaulted when unset. A fallback to localhost is how a
 * production process quietly writes to a developer's laptop.
 */
function url(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set");
  return value;
}

export const db = drizzle(neon(url()), { schema });
export { schema };
