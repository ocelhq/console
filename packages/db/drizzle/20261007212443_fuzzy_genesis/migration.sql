CREATE TYPE "environment_event_kind" AS ENUM('preview-removed', 'destroyed');--> statement-breakpoint
CREATE TABLE "environment_event" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"kind" "environment_event_kind" NOT NULL,
	"environment_class" "environment_class" NOT NULL,
	"environment_identity" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"git" jsonb,
	"ci" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "environment_event_project_idx" ON "environment_event" ("project_id","occurred_at");--> statement-breakpoint
ALTER TABLE "environment_event" ADD CONSTRAINT "environment_event_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;