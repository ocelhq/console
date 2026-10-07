ALTER TABLE "deployment" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "deployment_kind";--> statement-breakpoint
CREATE TYPE "deployment_kind" AS ENUM('deploy', 'preview-up', 'rollback');--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "kind" SET DATA TYPE "deployment_kind" USING "kind"::"deployment_kind";