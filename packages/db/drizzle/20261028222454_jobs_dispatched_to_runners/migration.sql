ALTER TYPE "deployment_outcome" ADD VALUE 'canceled';--> statement-breakpoint
ALTER TYPE "job_kind" ADD VALUE 'build' BEFORE 'deploy';--> statement-breakpoint
ALTER TYPE "job_kind" ADD VALUE 'projects-destroy';--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_runner_id_runner_id_fkey";--> statement-breakpoint
DROP TABLE "runner";--> statement-breakpoint
DROP INDEX "job_projectId_pr_held_uidx";--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "spec" jsonb;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "dispatched_at" timestamp;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "acknowledged_at" timestamp;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "unreachable_since" timestamp;--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "job_status";--> statement-breakpoint
CREATE TYPE "job_status" AS ENUM('queued', 'running', 'input-required', 'done', 'failed', 'canceled');--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "status" SET DATA TYPE "job_status" USING "status"::"job_status";--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "status" SET DEFAULT 'queued'::"job_status";--> statement-breakpoint
ALTER TABLE "job" DROP COLUMN "labels";--> statement-breakpoint
ALTER TABLE "job" DROP COLUMN "lease_until";--> statement-breakpoint
ALTER TABLE "job" DROP COLUMN "claims";--> statement-breakpoint
ALTER TABLE "job" DROP COLUMN "claimed_at";--> statement-breakpoint
ALTER TABLE "project_repo" DROP COLUMN "job_labels";--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "provider_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "target" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "outcome" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "deployed_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "trace" SET DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "topology" SET DEFAULT '{"apps":[],"resources":[],"usages":[]}';--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "tier" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "deployment_project_at_idx" ON "deployment" ("project_id",coalesce("deployed_at", "started_at", "created_at"));--> statement-breakpoint
CREATE UNIQUE INDEX "job_projectId_tier_pr_dispatched_uidx" ON "job" ("project_id","tier","pr") WHERE "dispatched_at" is not null and "status" in ('queued', 'running', 'input-required');--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_ended_at_once" CHECK (("outcome" is null) = ("deployed_at" is null));--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_outcome_has_writer" CHECK (("outcome" is null) = ("outcome_by" is null));--> statement-breakpoint
DROP TYPE "runner_kind";