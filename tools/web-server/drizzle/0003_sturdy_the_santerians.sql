CREATE TABLE "beans" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"name" text NOT NULL,
	"ratio" real NOT NULL,
	"brew_time_s" integer DEFAULT 30 NOT NULL,
	"roast_date" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "bean_id" text;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "brew_output_g" real;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "brew_time_s" integer;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "active_bean_id" text;--> statement-breakpoint
ALTER TABLE "beans" ADD CONSTRAINT "beans_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "beans_store_idx" ON "beans" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "annotations_store_bean_idx" ON "annotations" USING btree ("store_id","bean_id");