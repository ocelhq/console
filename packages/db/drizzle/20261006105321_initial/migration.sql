CREATE TYPE "connector_reach" AS ENUM('dial');--> statement-breakpoint
CREATE TYPE "compute_kind" AS ENUM('serverless', 'container');--> statement-breakpoint
CREATE TYPE "deployment_kind" AS ENUM('deploy', 'preview-up', 'preview-rm', 'rollback', 'destroy');--> statement-breakpoint
CREATE TYPE "deployment_outcome" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "environment_class" AS ENUM('production', 'preview');--> statement-breakpoint
CREATE TYPE "framework" AS ENUM('nextjs', 'react', 'astro', 'remix', 'nuxt', 'sveltekit', 'node', 'express', 'fastify', 'hono', 'bun', 'deno', 'go', 'python', 'django', 'rust');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"target" text NOT NULL,
	"vendor" text NOT NULL,
	"compute" "compute_kind",
	"reach" "connector_reach" DEFAULT 'dial'::"connector_reach" NOT NULL,
	"url" text,
	"public_key" text,
	"tls_pin" text,
	"version" text,
	"capabilities" jsonb DEFAULT '[]' NOT NULL,
	"connected_at" timestamp,
	"last_seen_at" timestamp,
	"last_denied" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" "deployment_kind" NOT NULL,
	"environment_class" "environment_class" NOT NULL,
	"environment_identity" text DEFAULT '' NOT NULL,
	"promotion_id" text,
	"tag" text,
	"provider_name" text NOT NULL,
	"provider_region" text,
	"target" text NOT NULL,
	"edge_kind" text,
	"outcome" "deployment_outcome" NOT NULL,
	"error" text,
	"trigger" jsonb NOT NULL,
	"git" jsonb,
	"cli_version" text,
	"started_at" timestamp,
	"deployed_at" timestamp NOT NULL,
	"trace" jsonb NOT NULL,
	"topology" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"frameworks" "framework"[] DEFAULT '{}'::"framework"[] NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_organization_target_uidx" ON "connector" ("organization_id","target");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_run_uidx" ON "deployment" ("project_id","run_id");--> statement-breakpoint
CREATE INDEX "deployment_project_latest_idx" ON "deployment" ("project_id","environment_class","deployed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_organizationId_slug_uidx" ON "project" ("organization_id","slug");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;