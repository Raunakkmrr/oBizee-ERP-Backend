import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  // Overridden by scripts/db-generate.sh — see the note there about exFAT.
  out: process.env.DRIZZLE_OUT ?? "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
} satisfies Config;
