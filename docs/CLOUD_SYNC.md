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

- **Accounts own stores; the device stays a bearer-key client.** Browser-side cloud
  flows require a signed-in account (Better Auth: email/password always, passkeys on
  top, GitHub when the deployment configures an OAuth app — `lib/auth-server.ts`,
  tables in `lib/auth-schema.ts`). Every store carries a non-null `owner_id` from
  birth; the owner's session cookie is the write credential for browser requests
  (`authStore` tries session first, then bearer keys) and the *only* credential for
  store management (create/rename/delete/provision/rotate — `authOwner`). The
  firmware knows nothing about accounts: it uploads with its `upload_key` exactly as
  before. No mail service exists, so there is **no password reset** — the sign-in UI
  says so and pushes GitHub-linking or a passkey as the backup way in.
- **Credential UX is password-manager-first.** The auth forms carry the markup managers
  (1Password, Keychain, Chrome) match on: `name` attributes, `autocomplete="username"` on
  the email field, `new-password`/`current-password` on the right side of the sign-in ↔
  sign-up toggle, and a `key={mode}` remount so the form re-reads as a *registration*
  form and offers to save. Change-password on `/account` includes the read-only username
  field managers need to know which login to update. The sign-in email field also carries
  the `webauthn` token and arms passkey conditional UI, so saved passkeys appear in the
  same autofill dropdown. The grinder's WiFi/PSK fields are marked `data-1p-ignore` —
  they are the appliance's credentials, not a login for this site.
- **Two keys per store, one job each.** `upload_key` is the device's HTTP credential:
  stored **hashed**, and **rotated on every provision** — any signed-in browser can
  provision a device (`POST /api/stores/[id]/provision` mints a fresh key for the BLE
  write), yet a DB dump never leaks a usable write credential. `view_key` is the
  semi-public read credential behind `#store=` share links and BLE claims: stored
  plaintext so any owner browser can produce a share link. Upload ⊇ view for reads;
  read ≠ write: sharing a dashboard never hands out write access.
- **Claim by possession is read-only.** Any browser reading a provisioned grinder over
  BLE gets `store_id + view_key` and becomes a *viewer* (exactly a share link). Owners
  get full access by signing in — which is also what syncs dashboards across browsers.
- **Store creation is owner-authed.** `POST /api/stores` requires a session; the
  per-account cap (`SYNC_STORES_PER_USER`) replaces the old per-IP limit, and the
  provisional-store 48 h GC is gone — stores are born owned, and deleting the account
  cascades through stores to sessions and snapshots.
- **CSRF/CORS split.** Wildcard CORS survives only on the key-authed routes (device
  ingest + cross-origin share-link reads carry no cookies). Session-authed routes are
  same-origin: Better Auth checks origins on its own endpoints; custom session
  mutations go through `assertSameOrigin` on top of SameSite=Lax cookies.
- **Lifecycle.** Store delete (cascade: blobs, summaries, snapshots, store) and
  `view_key` rotation are owner-session actions (Account page + WiFi & Sync). After a
  view-key rotation, re-provision the device so future BLE claims hand out the fresh
  key. `upload_key` leak recovery = just provision again (rotation is the mechanism).

## Limits (hosted)

- Upload size: reject > 64 KB sessions / > 4 KB snapshots at the edge, pre-storage.
- Checksum-invalid blobs rejected at ingest.
- Rate limit ~200 uploads/hour per store key (first-sync burst ≈ 100 fits).
- Quota: 10,000 sessions per store (~300 MB worst case, ≈ 5+ years at 5 grinds/day),
  counted on the summary table. Over quota → rotate oldest (mirrors the device's own
  ring-buffer behavior; recent grinds are the valuable ones) + dashboard banner pointing
  at self-hosting. Self-host: configurable/off.

## UX placement

- **Masthead:** account slot (sign in / email → `/account`). `/signin` offers GitHub
  (env-gated), email/password and passkey one-tap; `/account` manages sign-in methods,
  passkeys, the account's stores (rename / share link / delete) and account deletion
  (typed confirmation, cascades stores).
- **Flasher:** WiFi tab is **WiFi & Sync** — one flow provisions both (the coupling is
  real: sync needs WiFi). Requires sign-in; it reuses the device's store when the
  account owns it (rotating the upload key) or creates a fresh one, then writes the
  credentials over BLE in the same session. Forget Sync offers server-side deletion
  only to the owner.
- **Analytics: sources resolve owned-first.** Signed-in accounts get their stores (a
  picker when they own several, preference in `sgbwActiveStore` localStorage);
  otherwise a viewer link (`#store=` fragment or BLE claim, `sgbwCloudViewer`
  localStorage — no secrets beyond the semi-public view key). The cloud store is a
  superset of any BLE pull whenever reachable, so no merging. A BLE pull auto-backfills
  owned stores through the same idempotent ingest endpoint using the session cookie.
- **Device:** Menu → Settings → Cloud Sync (WiFi page pattern): enable toggle, status
  rows, Forget Sync.

## Implementation map

- **Server:** `tools/web-server` — Next.js (app router, strict TypeScript, Biome) +
  Drizzle/Postgres. Schema `lib/schema.ts` + `lib/auth-schema.ts` (migrations in
  `drizzle/`), ingest `lib/ingest.ts` (validates with the shared `lib/parser.ts` —
  the same TS parser the browser dashboard uses), request auth `lib/auth.ts`,
  Better Auth instance `lib/auth-server.ts` (lazy over `getDb()`; mounted at
  `app/api/auth/[...all]`), limits `lib/config.ts`, routes under `app/api/stores/`
  and `app/api/me/`. Checks: `pnpm test` (vitest + PGlite, real route handlers —
  including real Better Auth sign-ups), `pnpm typecheck`, `pnpm lint` (Biome).
  Deploy: Vercel (root `tools/web-server`) or `docker compose up` (app + Postgres,
  quota off; needs `BETTER_AUTH_SECRET`).
- **Firmware:** `src/system/cloud_sync.{h,cpp}` (uploader; NVS `cloudsync`),
  `WifiService::State::UPLOADING` (`src/system/wifi_service.*`), CRC-32 in
  `src/logging/grind_logging.cpp`, BLE characteristics in `src/config/bluetooth.h` +
  `src/bluetooth/manager.*`, settings page in `src/ui/screens/menu_screen.*` +
  `src/ui/controllers/menu_controller.*`, limits in `src/config/cloud_sync.h`.
- **Web:** all in `tools/web-server` — `lib/client/cloud.ts` (API client, share
  links, cloud pull/backfill), `components/grinder/wifi-sync-panel.tsx` (WiFi & Sync
  provisioning flow), `lib/analytics/store.ts` (IndexedDB v2 keyed by sha256, raw
  bytes retained), `lib/client/ble.ts` + `components/device-strip.tsx` (cloud status
  in the snapshot + device-strip chip), `app/analytics/page.tsx` +
  `components/analytics/cloud-bar.tsx` (dashboard cloud source).

## Build order

1. **Phase 1 — server first, browser is the first client.** Next.js app + Postgres +
   API + cloud dashboard source + browser backfill (the backfill exercises the exact
   ingest path the ESP will use — the API earns production traffic before any firmware
   ships).
2. **Phase 2 — firmware.** Provisioning characteristic + NVS, WifiService consumer,
   manifest sync + snapshot POST, settings page, WiFi & Sync flasher flow.
3. **Phase 3 — polish.** Python tool pulls from export endpoint, rotation UI niceties,
   device-strip chip refinements.
