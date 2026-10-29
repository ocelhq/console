CREATE TABLE "price_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"vendor" text NOT NULL,
	"service" text NOT NULL,
	"version" text NOT NULL,
	"manifest_sha256" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_product" (
	"catalog_id" uuid,
	"sku" text,
	"region" text,
	"product_family" text NOT NULL,
	"unit" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"tiers" jsonb NOT NULL,
	"source_url" text NOT NULL,
	CONSTRAINT "price_product_pkey" PRIMARY KEY("catalog_id","sku","region")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_bucket" (
	"key" text PRIMARY KEY,
	"tokens" double precision NOT NULL,
	"refilled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "estimate" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "price_catalog_vendor_service_uidx" ON "price_catalog" ("vendor","service");--> statement-breakpoint
CREATE INDEX "price_product_scope" ON "price_product" ("catalog_id","region","product_family");--> statement-breakpoint
CREATE INDEX "price_product_attributes" ON "price_product" USING gin ("attributes" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "rate_limit_bucket_refilled_at_idx" ON "rate_limit_bucket" ("refilled_at");--> statement-breakpoint
ALTER TABLE "price_product" ADD CONSTRAINT "price_product_catalog_id_price_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "price_catalog"("id") ON DELETE CASCADE;