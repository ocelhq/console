CREATE TYPE "job_kind" AS ENUM('deploy', 'preview-up', 'preview-rm');--> statement-breakpoint
CREATE TYPE "job_status" AS ENUM('queued', 'claimed', 'running', 'done', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "runner_kind" AS ENUM('managed', 'self-hosted');--> statement-breakpoint
CREATE TABLE "job" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"kind" "job_kind" NOT NULL,
	"status" "job_status" DEFAULT 'queued'::"job_status" NOT NULL,
	"pr" integer DEFAULT 0 NOT NULL,
	"sha" text,
	"branch" text,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"dedupe_key" text NOT NULL,
	"event_at" timestamp NOT NULL,
	"runner_id" text,
	"lease_until" timestamp,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"claims" integer DEFAULT 0 NOT NULL,
	"deployment_id" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"claimed_at" timestamp,
	"started_at" timestamp,
	"finished_at" timestamp,
	"revision" integer DEFAULT 1 NOT NULL,
	"synced_revision" integer DEFAULT 0 NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner" (
	"id" text PRIMARY KEY,
	"organization_id" text,
	"kind" "runner_kind" NOT NULL,
	"name" text NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"public_key" text NOT NULL,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "runner_managed_has_no_organization" CHECK (("kind" = 'managed') = ("organization_id" is null))
);
--> statement-breakpoint
DROP TABLE "git_delivery";--> statement-breakpoint
ALTER TABLE "project_repo" ADD COLUMN "production_branch" text NOT NULL;--> statement-breakpoint
ALTER TABLE "project_repo" ADD COLUMN "job_labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_projectId_dedupeKey_uidx" ON "job" ("project_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_projectId_pr_held_uidx" ON "job" ("project_id","pr") WHERE "status" in ('claimed', 'running');--> statement-breakpoint
CREATE INDEX "job_status_createdAt_idx" ON "job" ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_projectId_pr_idx" ON "job" ("project_id","pr","created_at");--> statement-breakpoint
CREATE INDEX "job_unsynced_idx" ON "job" ("changed_at") WHERE "revision" <> "synced_revision";--> statement-breakpoint
CREATE INDEX "runner_organizationId_idx" ON "runner" ("organization_id");--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_runner_id_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runner" ADD CONSTRAINT "runner_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;