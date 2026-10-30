UPDATE "job" SET "lane" = coalesce(
  "spec"->'preview'->>'name',
  (SELECT "d"."environment_identity" FROM "deployment" "d" WHERE "d"."project_id" = "job"."project_id" AND "d"."deployment_id" = "job"."deployment_id" AND "d"."environment_identity" <> ''),
  'pr-' || "pr"
) WHERE "tier" = 'preview' AND "lane" = '';
