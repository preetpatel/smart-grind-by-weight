# Cloud Sync — Design

Grind sessions sync from the grinder to an ingest server over WiFi. The ESP32 keeps its
existing space-bounded flash buffer (~100+ sessions); the server holds the full,
unbounded history and serves the analytics dashboard over it. This document records the
agreed design; each decision was made deliberately — change them knowingly.

## Product shape

- **One web app, two deploy targets.** A single Next.js app (`tools/web-server`) serves
  the existing web flasher (static assets, unchanged), the analytics dashboard, and the
  ingest/read API. It deploys to Vercel (the hosted service, replacing GitHub Pages) and
  ships as a Docker image (`docker compose up`: app + Postgres) for self-hosters. No
  Vercel-only APIs in core logic; the storage contract is a Postgres connection string.
- **The server is both dashboard and archive.** The dashboard renders full history
  (long-term trends, burr odometer, device health) — the views that suffer most from the
  ESP's session cap. A raw export endpoint keeps the Python tooling alive.
- **Firmware needs nothing except provisioning.** A device is configured over BLE with
  `{base_url, store_id, upload_key}`; everything else is server-side. Sync is **off until
  explicitly provisioned** — no phone-home of any kind without opt-in.

## Data model

- **Wire format = flash format.** The ESP uploads session files verbatim (packed structs:
  `TimeSeriesSessionHeader` + `GrindSession` + events + measurements, ~15–36 KB). No
  on-device JSON. The server is the third consumer of `grind_logging.h` (alongside the
  Python parser and `analytics/parser.js`) — struct changes must update it too.
- **Blob is truth, summary is index.** The server stores the raw blob verbatim (Postgres
  `bytea` — ~30 KB blobs are far below any bytea concern, and ingest is transactional:
  summary row + blob commit atomically). At ingest it parses only the header + the 80-byte
  `GrindSession` summary into an indexed `sessions` row (timestamp, target/final weight,
  error, mode, pulse count, termination reason, duration). Measurements stay in the blob
  and are parsed in the browser on demand by the existing `parser.js`. Schema evolution =
  version-aware parser over immutable blobs, never a time-series migration. The summary
  table is disposable: re-derivable from blobs.
- **Identity & dedup: `(store_id, sha256(blob))`.** The server computes SHA-256 at
  ingest; an identical blob re-uploaded to the same store is silently dropped. Same
  `session_id`, different hash → stored (NVS counter reset after factory reset, not a
  duplicate). Uniqueness is scoped to the store rather than the device so browser
  backfills from firmware that predates the device-id characteristic stay consistent
  with later device uploads — byte-identical 20 KB blobs from *different* grinders
  don't occur in practice. `device_id` (the ESP's factory MAC, `ESP.getEfuseMac()`,
  also exposed in the BLE system-info JSON) is stored as metadata on every row. The
  header checksum — a real zlib CRC-32 since this feature landed; 0 in legacy files —
  is verified at ingest when nonzero, for corruption rejection only, not identity.
- **Health snapshots ride along.** After each successful sync the device POSTs the same
  compact snapshot it serves over BLE (lifetime stats, diagnostics state, firmware
  version, OTA outcome; < 1 KB). Keyed `(device_id, received_at)`, kept as timestamped
  observations — this turns Device Health into a *history* (noise creep, calibration
  drift, error-rate vs firmware version), which BLE-only "now" reads can never show. Also
  feeds the burr odometer (lifetime stats predate the server and survive purges) and an
  update-available nudge.

## Sync protocol

- **Manifest handshake; the server is the only sync state.** Each window the device sends
  a manifest built from the 24-byte headers already on flash — one
  `(session_id, session_timestamp, session_size, checksum)` tuple per file (~a few bytes
  each). The server replies "send me these N"; the device POSTs just those, sequentially,
  one plain HTTP POST per session. Zero sync state in NVS. Wipe the server → next window
  re-uploads everything automatically; nothing to reset on the device. Tuple matching
  (not bare id) covers the counter-reset case.
- **No resume/chunking cleverness, ever.** Sessions are ≤ 36 KB; a failed POST is healed
  by the next manifest handshake by design.
- **Trigger = a rule, not an event:** whenever WiFi is connected, run a manifest sync if
  stale or a new session exists. The uploader is the second `WifiService` consumer (the
  seam the service was built for): grind-complete requests a window (a few seconds after
  returning to READY, clear of top-up pulses), and boot/daily windows sweep up anything
  missed, with WifiService's existing gating (never during grind/OTA/BLE export) and
  backoff. No new retry machinery.
- **Failure is silent and normal.** Self-hosted servers go down; no UI errors, nothing
  blocks. Status surfaces passively: Menu → Settings → Cloud Sync (last result/time,
  pending count) and a sync chip on the flasher device strip.
- **Transport: HTTPS to a real domain.** `esp_http_client` + ESP-IDF CA bundle validates
  Let's Encrypt/Vercel certs out of the box — no pinning, no cert provisioning. TLS RAM
  (~40 KB) is paid only inside windows, which never overlap grinds.

## Auth model — device is the credential

- **Two keys per store.** `upload_key` (write; lives on the device + provisioning
  browser) and `view_key` (read-only; shareable, lives in browser localStorage). Server
  middleware treats `upload_key` as a strict superset of `view_key` — one check, no
  per-endpoint confusion. Read ≠ write: sharing a dashboard never hands out write access.
- **Claim by possession.** Any new browser gets access by connecting to the grinder over
  BLE and reading `store_id + view_key` back from the device. No accounts, no passwords.
- **Store creation is provisional.** `POST /api/stores` is public (called by the flasher,
  which is public JS — possession gates *claiming*, not *creating*). Defenses: per-IP
  rate limit, and stores receiving no device upload within 48 h are garbage-collected.
  Bots mint empty rows that evaporate; only real grinders create persistent storage.
- **Lifecycle.** Delete (cascade: blobs, summaries, snapshots, store) requires
  `upload_key` — exposed in the flasher's WiFi & Sync section with confirm. `view_key`
  rotation (`upload_key`-authed) is the leak-recovery path; the flasher writes the fresh
  key back to the device so future BLE claims hand out the new one. `upload_key` leak
  recovery = delete + re-provision (its leak scenario is exotic by construction).

## Limits (hosted)

- Upload size: reject > 64 KB sessions / > 4 KB snapshots at the edge, pre-storage.
- Checksum-invalid blobs rejected at ingest.
- Rate limit ~200 uploads/hour per store key (first-sync burst ≈ 100 fits).
- Quota: 10,000 sessions per store (~300 MB worst case, ≈ 5+ years at 5 grinds/day),
  counted on the summary table. Over quota → rotate oldest (mirrors the device's own
  ring-buffer behavior; recent grinds are the valuable ones) + dashboard banner pointing
  at self-hosting. Self-host: configurable/off.

## UX placement

- **Flasher:** WiFi tab becomes **WiFi & Sync** — one flow provisions both (the coupling
  is real: sync needs WiFi). Store created at setup, keys written over BLE in the same
  session. Delete/rotate actions live here too.
- **Analytics tab: two sources, prefer cloud (no merging).** If `grinderRegistry` knows a
  store → load from API (instant, full history, works without the grinder awake).
  Otherwise → existing BLE pull, unchanged. The cloud store is a superset of any BLE pull
  whenever reachable, so merging buys nothing. A BLE pull additionally offers **"push to
  store"** — browser-side backfill through the same idempotent ingest endpoint.
- **Device:** Menu → Settings → Cloud Sync (WiFi page pattern): enable toggle, status
  rows, Forget Sync.

## Implementation map

- **Server:** `tools/web-server` — Next.js (app router, strict TypeScript, Biome) +
  Drizzle/Postgres. Schema `lib/schema.ts` (migrations in `drizzle/`), ingest
  `lib/ingest.ts` (imports the shared `tools/web-flasher/analytics/parser.js`,
  typed via `types/web-flasher-parser.d.ts`), auth `lib/auth.ts`, limits
  `lib/config.ts`, routes under `app/api/stores/`. Checks: `pnpm test` (vitest +
  PGlite, real route handlers), `pnpm typecheck`, `pnpm lint` (Biome). Deploy:
  Vercel (root `tools/web-server`) or `docker compose up` (app + Postgres, quota off).
- **Firmware:** `src/system/cloud_sync.{h,cpp}` (uploader; NVS `cloudsync`),
  `WifiService::State::UPLOADING` (`src/system/wifi_service.*`), CRC-32 in
  `src/logging/grind_logging.cpp`, BLE characteristics in `src/config/bluetooth.h` +
  `src/bluetooth/manager.*`, settings page in `src/ui/screens/menu_screen.*` +
  `src/ui/controllers/menu_controller.*`, limits in `src/config/cloud_sync.h`.
- **Web:** `tools/web-flasher/analytics/cloud.js` (API client, share links, cloud
  pull/backfill), `cloud-provision.js` (WiFi & Sync tab flow), `store.js` (IndexedDB
  v2 keyed by sha256, raw bytes retained), `grinder-session.js`/`grinder-card.js`
  (cloud status in the snapshot + device-strip chip).

## Build order

1. **Phase 1 — server first, browser is the first client.** Next.js app + Postgres +
   API + cloud dashboard source + browser backfill (the backfill exercises the exact
   ingest path the ESP will use — the API earns production traffic before any firmware
   ships).
2. **Phase 2 — firmware.** Provisioning characteristic + NVS, WifiService consumer,
   manifest sync + snapshot POST, settings page, WiFi & Sync flasher flow.
3. **Phase 3 — polish.** Python tool pulls from export endpoint, rotation UI niceties,
   device-strip chip refinements.
