CREATE TABLE "annotations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"sha256" text NOT NULL,
	"bean" text,
	"roast_date" text,
	"grind_setting" text,
	"note" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deleted_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"sha256" text NOT NULL,
	"session_id" bigint NOT NULL,
	"session_timestamp" bigint NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_sessions" ADD CONSTRAINT "deleted_sessions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "annotations_store_sha_uq" ON "annotations" USING btree ("store_id","sha256");--> statement-breakpoint
CREATE INDEX "annotations_store_updated_idx" ON "annotations" USING btree ("store_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deleted_sessions_store_sha_uq" ON "deleted_sessions" USING btree ("store_id","sha256");--> statement-breakpoint
CREATE INDEX "deleted_sessions_store_session_idx" ON "deleted_sessions" USING btree ("store_id","session_id","session_timestamp");