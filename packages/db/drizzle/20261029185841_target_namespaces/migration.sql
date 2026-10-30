DROP INDEX "target_organizationId_vendor_account_region_uidx";--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "namespace" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "target_organizationId_vendor_account_region_namespace_uidx" ON "target" ("organization_id","vendor","account","region","namespace");