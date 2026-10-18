import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./schema.ts";

/** Runtime mappings for the already-deployed platform tables (0076/0077).
 * Kept separate from the shared schema so the platform release does not absorb
 * unrelated tenant-runtime schema work. This file is not a migration entry. */
const money = (name: string) => bigint(name, { mode: "number" });

export const platformPlans = pgTable("platform_plans", {
  code: text("code").primaryKey(), name: text("name").notNull(),
  modules: jsonb("modules").$type<string[]>().notNull(),
  allowances: jsonb("allowances").$type<{ users: number; storageBytes: number;
    communications: number }>().notNull(),
  monthlyPricePaise: money("monthly_price_paise").notNull(),
  trialDays: integer("trial_days").notNull(), active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const tenantSubscriptions = pgTable("tenant_subscriptions", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  planCode: text("plan_code").notNull().references(() => platformPlans.code),
  status: text("status").$type<"TRIAL" | "ACTIVE" | "PAST_DUE" | "EXPIRED" | "CLOSED">().notNull(),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  periodStartsAt: timestamp("period_starts_at", { withTimezone: true }).notNull().defaultNow(),
  periodEndsAt: timestamp("period_ends_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const subscriptionEvents = pgTable("subscription_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  kind: text("kind").notNull(), planCode: text("plan_code").notNull(),
  amountPaise: money("amount_paise").notNull().default(0),
  invoiceNumber: text("invoice_number"), note: text("note").notNull(),
  actor: text("actor").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("subscription_events_tenant_idx").on(table.tenantId, table.occurredAt)]);
export const tenantLifecycle = pgTable("tenant_lifecycle", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  status: text("status").$type<"ACTIVE" | "PAUSED" | "CLOSED">().notNull().default("ACTIVE"),
  reason: text("reason"), retentionUntil: timestamp("retention_until", { withTimezone: true }),
  lastExportAt: timestamp("last_export_at", { withTimezone: true }),
  lastExportSha256: text("last_export_sha256"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  changedBy: text("changed_by").notNull(),
});
export const platformSupportGrants = pgTable("platform_support_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  adminEmail: text("admin_email").notNull(), reason: text("reason").notNull(),
  beginsAt: timestamp("begins_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const platformAudit = pgTable("platform_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id),
  actor: text("actor").notNull(), action: text("action").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});
