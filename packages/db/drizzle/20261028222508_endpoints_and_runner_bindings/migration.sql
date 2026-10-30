CREATE TYPE "endpoint_reach" AS ENUM('dial');--> statement-breakpoint
CREATE TYPE "runner_kind" AS ENUM('ocel-cloud', 'endpoint');--> statement-breakpoint
CREATE TABLE "endpoint" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"target" text,
	"vendor" text NOT NULL,
	"compute" "compute_kind",
	"reach" "endpoint_reach" DEFAULT 'dial'::"endpoint_reach" NOT NULL,
	"url" text,
	"public_key" text,
	"tls_pin" text,
	"version" text,
	"services" jsonb DEFAULT '[]' NOT NULL,
	"allowed_scopes" jsonb DEFAULT '[]' NOT NULL,
	"connected_at" timestamp,
	"last_seen_at" timestamp,
	"last_denied" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_binding" (
	"project_id" text,
	"tier" "tier",
	"runner" "runner_kind" NOT NULL,
	"endpoint_id" text,
	"credentials" boolean DEFAULT false NOT NULL,
	"bound_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "runner_binding_pkey" PRIMARY KEY("project_id","tier"),
	CONSTRAINT "runner_binding_endpoint_named" CHECK (("runner" = 'endpoint') = ("endpoint_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_organizationId_name_uidx" ON "endpoint" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_organizationId_target_uidx" ON "endpoint" ("organization_id","target");--> statement-breakpoint
CREATE INDEX "runner_binding_endpointId_idx" ON "runner_binding" ("endpoint_id");--> statement-breakpoint
ALTER TABLE "endpoint" ADD CONSTRAINT "endpoint_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runner_binding" ADD CONSTRAINT "runner_binding_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runner_binding" ADD CONSTRAINT "runner_binding_endpoint_id_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoint"("id") ON DELETE CASCADE;