CREATE TYPE "deploy_mode" AS ENUM('runners', 'ci');--> statement-breakpoint
CREATE TYPE "pipeline_kind" AS ENUM('github-actions');--> statement-breakpoint
CREATE TYPE "pipeline_origin" AS ENUM('linked', 'manual');--> statement-breakpoint
CREATE TABLE "pipeline_token" (
	"issuer" text,
	"jti" text,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "pipeline_token_pkey" PRIMARY KEY("issuer","jti")
);
--> statement-breakpoint
CREATE TABLE "trusted_pipeline" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"kind" "pipeline_kind" NOT NULL,
	"repository" text NOT NULL,
	"repository_id" text,
	"repository_owner_id" text,
	"workflow" text,
	"environment" text,
	"branches" text[] DEFAULT '{*}'::text[] NOT NULL,
	"origin" "pipeline_origin" NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "principal" jsonb;--> statement-breakpoint
ALTER TABLE "environment_event" ADD COLUMN "principal" jsonb;--> statement-breakpoint
ALTER TABLE "project_repo" ADD COLUMN "repo_owner_id" text;--> statement-breakpoint
ALTER TABLE "project_repo" ADD COLUMN "deploys" "deploy_mode" DEFAULT 'runners'::"deploy_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "run_url" text;--> statement-breakpoint
CREATE INDEX "pipeline_token_expiresAt_idx" ON "pipeline_token" ("expires_at");--> statement-breakpoint
CREATE INDEX "trusted_pipeline_projectId_idx" ON "trusted_pipeline" ("project_id");--> statement-breakpoint
ALTER TABLE "trusted_pipeline" ADD CONSTRAINT "trusted_pipeline_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "trusted_pipeline" ADD CONSTRAINT "trusted_pipeline_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;