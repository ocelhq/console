ALTER TABLE "project" ALTER COLUMN "frameworks" SET DATA TYPE text[];--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "frameworks" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "framework";--> statement-breakpoint
CREATE TYPE "framework" AS ENUM('next', 'react', 'astro', 'remix', 'nuxt', 'sveltekit', 'node', 'express', 'fastify', 'hono', 'bun', 'deno', 'go', 'python', 'django', 'rust');--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "frameworks" SET DATA TYPE "framework"[] USING "frameworks"::"framework"[];--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "frameworks" SET DEFAULT '{}'::"framework"[];