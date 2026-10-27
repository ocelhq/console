CREATE TYPE "issuance_purpose" AS ENUM('deploy', 'test');--> statement-breakpoint
CREATE TABLE "credential_issuance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text NOT NULL,
	"project_id" text,
	"target_id" uuid NOT NULL,
	"tier" "tier" NOT NULL,
	"purpose" "issuance_purpose" DEFAULT 'deploy'::"issuance_purpose" NOT NULL,
	"principal" jsonb NOT NULL,
	"token_jti" text NOT NULL,
	"issued_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" text NOT NULL,
	"vendor" text NOT NULL,
	"account" text NOT NULL,
	"region" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_binding" (
	"project_id" text,
	"tier" "tier",
	"target_id" uuid NOT NULL,
	CONSTRAINT "target_binding_pkey" PRIMARY KEY("project_id","tier")
);
--> statement-breakpoint
CREATE TABLE "target_tier" (
	"target_id" uuid,
	"tier" "tier",
	"identity_provider" text NOT NULL,
	"principal" text NOT NULL,
	"grants" text[] NOT NULL,
	"cli_version" text NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"last_issued_at" timestamp,
	CONSTRAINT "target_tier_pkey" PRIMARY KEY("target_id","tier")
);
--> statement-breakpoint
ALTER TABLE "trusted_pipeline" ADD COLUMN "credentials" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_issuance_tokenJti_uidx" ON "credential_issuance" ("token_jti");--> statement-breakpoint
CREATE INDEX "credential_issuance_organizationId_issuedAt_idx" ON "credential_issuance" ("organization_id","issued_at");--> statement-breakpoint
CREATE INDEX "credential_issuance_projectId_issuedAt_idx" ON "credential_issuance" ("project_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "target_organizationId_vendor_account_region_uidx" ON "target" ("organization_id","vendor","account","region");--> statement-breakpoint
CREATE INDEX "target_binding_targetId_idx" ON "target_binding" ("target_id");--> statement-breakpoint
ALTER TABLE "credential_issuance" ADD CONSTRAINT "credential_issuance_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "target" ADD CONSTRAINT "target_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "target_binding" ADD CONSTRAINT "target_binding_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "target_binding" ADD CONSTRAINT "target_binding_target_id_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "target_tier" ADD CONSTRAINT "target_tier_target_id_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target"("id") ON DELETE CASCADE;