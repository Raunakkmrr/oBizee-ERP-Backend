ALTER TABLE "contacts" ALTER COLUMN "role_label" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."contact_role";--> statement-breakpoint
CREATE TYPE "public"."contact_role" AS ENUM('OWNER', 'SITE_INCHARGE', 'TENANT', 'SECURITY', 'ACCOUNTS', 'OTHER');--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "role_label" SET DATA TYPE "public"."contact_role" USING "role_label"::"public"."contact_role";