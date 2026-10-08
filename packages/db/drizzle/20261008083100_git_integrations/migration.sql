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
CREATE TABLE "git_delivery" (
	"git_app_id" text,
	"delivery_id" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_delivery_pkey" PRIMARY KEY("git_app_id","delivery_id")
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
CREATE TABLE "project_repo" (
	"project_id" text PRIMARY KEY,
	"installation_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"full_name" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "git_app_kind_appId_uidx" ON "git_app" ("kind","app_id");--> statement-breakpoint
CREATE INDEX "git_delivery_receivedAt_idx" ON "git_delivery" ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_installation_gitAppId_externalId_uidx" ON "git_installation" ("git_app_id","external_id");--> statement-breakpoint
CREATE INDEX "project_repo_installationId_repoId_idx" ON "project_repo" ("installation_id","repo_id");--> statement-breakpoint
ALTER TABLE "git_app" ADD CONSTRAINT "git_app_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "git_delivery" ADD CONSTRAINT "git_delivery_git_app_id_git_app_id_fkey" FOREIGN KEY ("git_app_id") REFERENCES "git_app"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_git_app_id_git_app_id_fkey" FOREIGN KEY ("git_app_id") REFERENCES "git_app"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_repo" ADD CONSTRAINT "project_repo_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_repo" ADD CONSTRAINT "project_repo_installation_id_git_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "git_installation"("id") ON DELETE CASCADE;