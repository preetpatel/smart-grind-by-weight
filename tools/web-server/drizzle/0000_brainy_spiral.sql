CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"device_id" text,
	"sha256" text NOT NULL,
	"source" text DEFAULT 'device' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" bigint NOT NULL,
	"session_timestamp" bigint NOT NULL,
	"session_size" integer NOT NULL,
	"header_checksum" bigint NOT NULL,
	"schema_version" integer NOT NULL,
	"event_count" integer NOT NULL,
	"measurement_count" integer NOT NULL,
	"grind_mode" smallint,
	"profile_id" smallint,
	"target_weight" real,
	"final_weight" real,
	"error_grams" real,
	"target_time_ms" bigint,
	"total_time_ms" bigint,
	"total_motor_on_time_ms" bigint,
	"time_error_ms" bigint,
	"pulse_count" smallint,
	"termination_reason" smallint,
	"result_status" text,
	"blob" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"device_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" text PRIMARY KEY NOT NULL,
	"upload_key_hash" text NOT NULL,
	"view_key_hash" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_ip" text,
	"first_upload_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_store_sha_uq" ON "sessions" USING btree ("store_id","sha256");--> statement-breakpoint
CREATE INDEX "sessions_store_received_idx" ON "sessions" USING btree ("store_id","received_at","id");--> statement-breakpoint
CREATE INDEX "sessions_store_session_idx" ON "sessions" USING btree ("store_id","session_id");--> statement-breakpoint
CREATE INDEX "snapshots_store_received_idx" ON "snapshots" USING btree ("store_id","received_at","id");