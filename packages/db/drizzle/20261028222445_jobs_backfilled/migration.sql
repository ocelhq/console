UPDATE "job" SET "tier" = CASE "kind" WHEN 'deploy' THEN 'production'::"tier" ELSE 'preview'::"tier" END WHERE "tier" IS NULL;--> statement-breakpoint
UPDATE "job" SET "status" = 'failed', "error" = coalesce("error", 'the console stopped claiming jobs before this one ran'), "finished_at" = coalesce("finished_at", now()), "revision" = "revision" + 1, "changed_at" = now() WHERE "status" IN ('queued', 'claimed', 'running');--> statement-breakpoint
UPDATE "deployment" SET "outcome_by" = 'ocel' WHERE "outcome" IS NOT NULL AND "outcome_by" IS NULL;
