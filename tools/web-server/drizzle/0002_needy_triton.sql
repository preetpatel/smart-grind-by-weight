ALTER TABLE "stores" ADD COLUMN "device_id" text;--> statement-breakpoint
-- Stores that predate the binding adopt the grinder that most recently
-- uploaded into them. Where one grinder fed several stores, the most recent
-- wins and the others stay unbound archives — the binding is unique, and a
-- store left unbound heals the moment its grinder is provisioned again.
WITH activity AS (
    SELECT store_id, device_id, received_at FROM sessions WHERE device_id IS NOT NULL
    UNION ALL
    SELECT store_id, device_id, received_at FROM snapshots WHERE device_id IS NOT NULL
), newest_per_store AS (
    SELECT DISTINCT ON (store_id) store_id, device_id, received_at
    FROM activity ORDER BY store_id, received_at DESC
), winner AS (
    SELECT DISTINCT ON (device_id) store_id, device_id
    FROM newest_per_store ORDER BY device_id, received_at DESC
)
UPDATE stores SET device_id = winner.device_id
FROM winner WHERE stores.id = winner.store_id;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_device_uq" ON "stores" USING btree ("device_id") WHERE "stores"."device_id" is not null;
