CREATE TYPE "outcome_writer" AS ENUM('ocel', 'console');--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "outcome_by" "outcome_writer";--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "tier" "tier";