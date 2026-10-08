ALTER TYPE "environment_class" RENAME TO "tier";--> statement-breakpoint
ALTER TABLE "deployment" RENAME COLUMN "run_id" TO "deployment_id";--> statement-breakpoint
ALTER TABLE "deployment" RENAME COLUMN "environment_class" TO "tier";--> statement-breakpoint
ALTER TABLE "environment_event" RENAME COLUMN "run_id" TO "deployment_id";--> statement-breakpoint
ALTER TABLE "environment_event" RENAME COLUMN "environment_class" TO "tier";--> statement-breakpoint
ALTER INDEX "deployment_run_uidx" RENAME TO "deployment_deployment_id_uidx";--> statement-breakpoint
ALTER INDEX "environment_event_run_uidx" RENAME TO "environment_event_deployment_id_uidx";--> statement-breakpoint
UPDATE "deployment" SET "topology" = jsonb_set("topology", '{apps}', (
	SELECT jsonb_agg(
		CASE WHEN "app" ? 'deploymentId'
			THEN ("app" - 'deploymentId') || jsonb_build_object('release', "app" -> 'deploymentId')
			ELSE "app"
		END ORDER BY "position")
	FROM jsonb_array_elements("topology" -> 'apps') WITH ORDINALITY AS "apps" ("app", "position")
)) WHERE jsonb_path_exists("topology", '$.apps[*].deploymentId');