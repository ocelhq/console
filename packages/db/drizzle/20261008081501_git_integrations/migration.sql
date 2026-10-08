CREATE TYPE "git_kind" AS ENUM('github');--> statement-breakpoint
CREATE TABLE "git_app" (
	"id" text PRIMARY KEY,
	"organization_id" text,
	"kind" "git_kind" NOT NULL,
	"app_id" text NOT NULL,
	"slug" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_installation" (
	"id" text PRIMARY KEY,
	"git_app_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"external_id" text NOT NULL,
	"account" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "repo_installation_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "repo_full_name" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "repo_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "git_app_kind_appId_uidx" ON "git_app" ("kind","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_installation_gitAppId_externalId_uidx" ON "git_installation" ("git_app_id","external_id");--> statement-breakpoint
CREATE INDEX "project_repoId_idx" ON "project" ("repo_id");--> statement-breakpoint
ALTER TABLE "git_app" ADD CONSTRAINT "git_app_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_git_app_id_git_app_id_fkey" FOREIGN KEY ("git_app_id") REFERENCES "git_app"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_repo_installation_id_git_installation_id_fkey" FOREIGN KEY ("repo_installation_id") REFERENCES "git_installation"("id") ON DELETE SET NULL;