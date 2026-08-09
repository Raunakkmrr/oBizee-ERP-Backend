CREATE TYPE "public"."stock_location_kind" AS ENUM('STORE', 'VAN');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_kind" AS ENUM('RECEIPT', 'ISSUE_TO_VAN', 'RETURN_TO_STORE', 'CONSUME', 'ADJUSTMENT');--> statement-breakpoint
CREATE TABLE "parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"unit" text DEFAULT 'no' NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"preferred_vendor_id" uuid,
	"unit_cost_paise" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parts_tenant_name_uq" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "stock_location_kind" NOT NULL,
	"technician_id" uuid,
	"branch_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "stock_locations_tenant_name_uq" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"qty" integer NOT NULL,
	"job_id" uuid,
	"purchase_bill_id" uuid,
	"challan_number" text,
	"note" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_preferred_vendor_id_vendors_id_fk" FOREIGN KEY ("preferred_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_from_location_id_stock_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."stock_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_to_location_id_stock_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."stock_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_purchase_bill_id_purchase_bills_id_fk" FOREIGN KEY ("purchase_bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parts_tenant_idx" ON "parts" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE INDEX "stock_movements_part_idx" ON "stock_movements" USING btree ("tenant_id","part_id");--> statement-breakpoint
CREATE INDEX "stock_movements_when_idx" ON "stock_movements" USING btree ("tenant_id","occurred_at");
--> statement-breakpoint

/*
  The stock ledger is insert-only.

  On-hand is summed from these rows, so editing one rewrites a balance without
  leaving a trace of the rewrite — and the whole reason to keep a ledger rather
  than a number is that the history survives. A movement recorded in error is
  corrected by recording the correction, which is what ADJUSTMENT is for.

  Same guard as `rate_rows` and `audit_entries`, and the same reasoning.
*/
CREATE TRIGGER stock_movements_insert_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

--> statement-breakpoint

/*
  A movement goes from somewhere, to somewhere, or both — never neither.

  A row with no source and no destination changes no balance and records no
  fact; it is a hole in the ledger that still counts as an entry.
*/
ALTER TABLE "stock_movements"
  ADD CONSTRAINT stock_movements_has_direction
  CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL);

--> statement-breakpoint

/* Quantity is a magnitude; direction is `from` and `to`. */
ALTER TABLE "stock_movements"
  ADD CONSTRAINT stock_movements_positive_qty CHECK (qty > 0);

--> statement-breakpoint

/* A van belongs to somebody. §6.14: "Van 3" is not actionable, "Ramesh's van" is. */
ALTER TABLE "stock_locations"
  ADD CONSTRAINT stock_locations_van_has_owner
  CHECK (kind <> 'VAN' OR technician_id IS NOT NULL);
