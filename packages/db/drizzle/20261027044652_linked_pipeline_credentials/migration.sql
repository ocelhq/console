-- Custom SQL migration file, put your code below! --
UPDATE "trusted_pipeline" AS "pipeline"
SET "credentials" = jsonb_build_object(
  'production', jsonb_build_object('branches', jsonb_build_array("repo"."production_branch")),
  'preview', jsonb_build_object('branches', jsonb_build_array('*'))
)
FROM "project_repo" AS "repo"
WHERE "pipeline"."project_id" = "repo"."project_id"
  AND "pipeline"."origin" = 'linked'
  AND "pipeline"."credentials" = '{}'::jsonb;
