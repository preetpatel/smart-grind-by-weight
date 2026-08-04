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
  also exposed in the BLE system-info JSON) is stored as metadata on every row, and is
  the key the store itself is bound to — see "One grinder, one store". The
  header checksum — a real zlib CRC-32 since this feature landed; 0 in legacy files —
  is verified at ingest when nonzero, for corruption rejection only, not identity.
- **Health snapshots ride along.** After each successful sync the device POSTs the same
  compact snapshot it serves over BLE (lifetime stats, diagnostics state, firmware
  version, OTA outcome; < 1 KB). Keyed `(device_id, received_at)`, kept as timestamped
  observations — this turns the Health view into a *history* (noise creep, calibration
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
  pending count) and the backup row on the web app's home page.
- **Transport: HTTPS to a real domain.** `esp_http_client` + ESP-IDF CA bundle validates
  Let's Encrypt/Vercel certs out of the box — no pinning, no cert provisioning. TLS RAM
  (~40 KB) is paid only inside windows, which never overlap grinds.

## Annotations and deletion

- **Annotations are local-first.** Bean, roast date, grind setting, note and tags are
  keyed by the session's `sha256`, not a foreign key — an annotation written before the
  session finishes uploading still lands on it, and survives re-ingest. The browser
  writes to IndexedDB immediately and works with no account; the `annotations` table is
  the copy that follows an account across browsers. Reconciliation is per row,
  last-write-wins on `updated_at`, so two browsers editing different grinds never
  collide and a stale tab flushing late is dropped rather than applied.
- **Deletion needs a tombstone.** The manifest handshake is stateless by design — it
  asks the server what it lacks — so deleting a row alone invites the grinder to upload
  it again on the next window. `DELETE /api/stores/[id]/sessions/[sha]` (owner session
  only) records `deleted_sessions` with both the content hash and the
  `(session_id, session_timestamp)` pair the device identifies files by, since the
  device cannot know the hash of a file it has not sent. The manifest treats a tombstone
  as "already have it", and ingest rejects a tombstoned blob outright rather than
  trusting the manifest to have been consulted.

## Beans and brew records

- **A bean is one bag** (`beans`: name, brew ratio, shot time, roast date, notes,
  archived_at), owned by the store; `stores.active_bean_id` is the bag in the hopper.
  The server is the source of truth: the dashboard's beans page writes it first, then
  best-effort pushes `{name, ratio, brew_time_s, dose_g, yield_min_g, yield_max_g,
  time_min_s, time_max_s}` to the grinder over BLE
  (`BLE_SYSINFO_BEAN_CONFIG_CHAR_UUID`), and the sync window's config fetch
  (`GET /config`) converges a grinder no browser is near. Both channels carry the same
  server state into the `bean` NVS namespace, so they cannot disagree.
- **A bag states a recipe, not a number** — "dose 20.5 g, yield 27–30 g, time 25–31 s".
  Those numbers routinely contradict the bag's own printed ratio (20.5 × 1.5 = 30.75,
  outside 27–30), so the five recipe columns store what was typed and the ratio becomes
  a derived display value; a range held as a *ratio* range would silently rewrite the
  roaster. All five are nullable — a bean with none behaves exactly as before ranges
  existed. `resolveRecipe` (`lib/beans.ts`, mirrored in `lib/analytics/brew.ts` and by
  `BeanConfig::recipe_for_dose` on the device) resolves them for the dose a grind
  actually delivered: the **yield band scales** by `dose ÷ dose_g`, because the range
  is quoted at a reference dose; the **time band does not**, being an absolute the
  roaster stated. With no stated yield range the band falls back to dose × ratio ±3%
  (`USER_BREW_ON_TARGET_BAND_PCT`); with no stated time range there is deliberately no
  fallback at all, since a tolerance nobody wrote down must not become evidence.
- **Attribution is stamped at ingest**: a session arriving while a bean is active gets
  `annotations.bean_id` filled — only when blank (`coalesce`), and without touching
  `updated_at`, so a hand-picked bean and the LWW reconcile are never overridden.
- **Brew records ride the same identity pair as the manifest.** The grinder's
  post-grind entry screen queues `{session_id, session_timestamp, output_g,
  brew_time_s}` under `/brews` on LittleFS (deliberately not `/sessions`, whose
  retention purge and manifest scan treat every file as a session). `POST /brews`
  resolves the pair to the session's `sha256` and lands `brew_output_g`/`brew_time_s`
  on its annotation row; `stored`/`deleted` (tombstoned) drop the queued file,
  `unknown` keeps it for the next window. The response echoes `{bean, advice}` so a
  logged shot refreshes the verdict in one round trip.
- **Unmeasured time is null, never a default.** `brew_time_s` of `0` (the user skipped
  the time step) or absent (firmware that never asked) both store null. Before this,
  every record carried the bean's pinned 30 s, which made a real 30 s shot
  indistinguishable from an unanswered prompt in the column the advice engine reads as
  evidence. Rows written under the old behaviour cannot be told apart retroactively;
  they are only ever read by the yield-deviation path below.
- **Advice is computed server-side** (`lib/advice.ts`, mirrored client-side in
  `lib/analytics/brew.ts` — change one, change both), and reports which of two readings
  produced it as `basis`. Where the bag states a target time *and* the window's shots
  were really timed (`basis: 'time'`), the clock decides, which is the classic dial-in
  loop: hold the dose and the yield, and let time say whether the grind is too fine or
  too coarse. Each shot's time is first normalised to the middle of its yield band
  (`time × target_yield ÷ output`), so a shot stopped short doesn't read as fast for the
  wrong reason; the median then lands under `time_min_s` → finer, over `time_max_s` →
  coarser. Untimed shots never enter that median — they answered a different question.
  Otherwise (`basis: 'yield'`) the original reading stands: with time assumed fixed,
  output deviation is a flow proxy, median of the last 5 shots beyond ±8% meaning finer
  (ran fast) or coarser (choked). Both need at least 3 shots, and a recorded
  grind-setting change resets the evidence either way. The grinder only displays the
  verdict (ready-screen chip), so thresholds evolve without firmware releases.
- **Bag tracking follows the same split.** An optional `beans.bag_size_g` enables it:
  the server sums the doses of every session attributed to the bag, estimates the
  per-shot dose from the median of the last 10, and ships
  `bag: {size_g, used_g, shots_remaining, low}` (low at ≤5 shots) alongside the
  advice in `GET /config` and the `POST /brews` echo. The grinder holds it as
  runtime-only state and shows "N SHOTS LEFT" on the shared ready-screen chip — bag
  warnings outrank the dial-in verdict, and a dismissed warning returns when the
  count drops. Purge-mode waste isn't in the session summary, so the estimate runs
  slightly optimistic; the threshold absorbs it.

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
  says so and pushes GitHub-linking or a passkey as the backup way in. On `/account` that
  warning is **conditional on actually having no way back in** (no linked GitHub *and* no
  passkey); as a permanent subtitle it kept warning about lost access to accounts that
  already had both.
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
- **One grinder, one store.** `stores.device_id` holds the grinder's factory MAC under a
  partial unique index (NULL = unbound), so the 1:1 rule is a database constraint rather
  than UI etiquette in one component. `POST /api/stores` is idempotent per device and
  requires one: the caller's own grinder gets its existing store back with a freshly
  rotated upload key (creating *is* provisioning), an unknown grinder gets a new store,
  and the per-account cap (`SYNC_STORES_PER_USER`) is only a backstop. That is what makes
  a second browser, a Forget Sync or a factory reset land back on the same history instead
  of orphaning it in a store nothing points at any more. `POST /api/stores/[id]/provision`
  optionally carries a `device_id`, binding a store that has none (migrated, or released)
  and refusing one that already belongs to a different grinder. Ingest checks
  `x-device-id` against the binding on key-authed requests (403 `device_mismatch`), which
  closes the two-grinders-one-store direction; browser backfill rides the owner's cookie
  and is exempt, since local records carry no per-record device id. Existing stores
  adopted the grinder that had most recently uploaded to them (migration `0002`).
- **Takeover is possession-gated and moves no data.** Claiming a grinder registered to
  another account requires the `store_id + view_key` pair the device itself hands out over
  BLE. It unbinds the previous store — which keeps every grind as a readable archive for
  its owner — and creates an *empty* store for the claimant, so a resold grinder never
  carries its history to the new owner. `POST /api/stores/[id]/release` is the deliberate
  version of the same thing, and the one that works without the grinder in hand. Known
  limit: a `#store=` share link carries that same view key, so a link recipient could
  claim the grinder; the blast radius is "uploads fail until re-provisioned", never data
  disclosure, and closing it properly needs a device-attested nonce (a firmware protocol
  change). Forget Sync deliberately does *not* release — the grinder keeps its home so
  setting sync up again returns to the same history.
- **CSRF/CORS split.** Wildcard CORS survives only on the key-authed routes (device
  ingest + cross-origin share-link reads carry no cookies). Session-authed routes are
  same-origin: Better Auth checks origins on its own endpoints; custom session
  mutations go through `assertSameOrigin` on top of SameSite=Lax cookies.
- **Lifecycle.** Store delete (cascade: blobs, summaries, snapshots, store), grinder
  release and `view_key` rotation are owner-session actions (Account page, WiFi & Backup,
  and Revoke shared links in the analytics cloud bar). After a
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
  passkeys, the account's stores (each showing its grinder, or an *Archive* badge when
  unbound — rename / share link / release / delete) and account deletion (typed
  confirmation, cascades stores).
- **One grinder, one name.** The sidebar switcher reads `grinderRegistry` in localStorage
  (labelled from the BLE advertised name at pairing: "GrindByWeight", "GrindByWeight 2");
  the store carries its own `name`. These used to drift — renaming the backup left the
  sidebar on the generic label. Renaming in *either* place now sets both:
  `ble.renameByDeviceId()` joins them on the factory MAC (the registry is keyed by the
  browser's Web Bluetooth device id, the store by the MAC, and the snapshot carries the
  MAC), and the switcher's own Rename pushes to the bound store when one is owned. The
  store lookup happens inside the rename handler, not on render — the sidebar is on every
  page and otherwise has no need for the account's stores.
- **Auth has its own frame.** The app shell lives in the `app/(app)` route group; `/signin`
  sits in `app/(auth)`, which renders one centred column and a link home instead of a
  sidebar full of grinder routes a signed-out visitor can't use. URLs are unchanged —
  route groups don't appear in the path.
- **`/account` is a list of facts, each with its action attached.** *Signing in* holds the
  two singleton methods (password, GitHub) as one row each; **passkeys get their own
  section**, because they are a collection you add to and remove from and because a row
  labelled "This Mac" says nothing about what it is without a heading over it — that
  section carries *Add a passkey* on its heading line and an empty state of its own.
  Backups are one row per store, with
  *Copy link* inline and rename / release / delete behind a `⋯` menu — the grinder id lives
  in that menu rather than the row, being a lookup rather than something you scan a list by.
  Every row is one line: name left, state right, action last, stacking under `sm`. Nothing that is used
  once a year sits expanded: change-password and account deletion are dialogs
  (`components/auth/{change-password,delete-account}-dialog.tsx`), so the page stays
  scannable and an irreversible form is never one stray click from submitting.
- **Web app:** the WiFi page is **WiFi & Backup** — one flow provisions both (the coupling is
  real: sync needs WiFi). Requires sign-in. It reads the grinder *live* over BLE first —
  never the cached snapshot, which is how a browser with cold `localStorage` used to mint
  a duplicate store — then lets the server pick the store from the device id and writes
  the credentials back over BLE in the same session. Setting up cloud backup is only
  offered here, with a grinder present; the analytics bar links to it rather than
  creating a storeless backup. Forget Sync offers server-side deletion only to the owner.
- **Analytics: sources resolve owned-first.** Signed-in accounts get their stores (an
  explicit pick in `sgbwActiveStore` localStorage wins, then the store bound to the
  connected grinder, then the newest; a picker appears when they own several);
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
  `app/api/auth/[...all]`), limits `lib/config.ts`, grinder identity
  `lib/device-id.ts`, routes under `app/api/stores/` (including `[id]/provision`
  and `[id]/release`) and `app/api/me/`. Checks: `pnpm test` (vitest + PGlite, real route handlers —
  including real Better Auth sign-ups), `pnpm typecheck`, `pnpm lint` (Biome).
  Deploy: Vercel (root `tools/web-server`) or `docker compose up` (app + Postgres,
  quota off; needs `BETTER_AUTH_SECRET`).
- **Firmware:** `src/system/cloud_sync.{h,cpp}` (uploader; NVS `cloudsync`),
  `WifiService::State::UPLOADING` (`src/system/wifi_service.*`), CRC-32 in
  `src/logging/grind_logging.cpp`, BLE characteristics in `src/config/bluetooth.h` +
  `src/bluetooth/manager.*`, settings page in `src/ui/screens/menu_screen.*` +
  `src/ui/controllers/menu_controller.*`, limits in `src/config/cloud_sync.h`.
- **Web:** all in `tools/web-server` — `lib/client/cloud.ts` (API client, share
  links, cloud pull/backfill), `components/grinder/wifi-sync-panel.tsx` (WiFi & Backup
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
   manifest sync + snapshot POST, settings page, WiFi & Backup flasher flow.
3. **Phase 3 — polish.** Python tool pulls from export endpoint, rotation UI niceties,
   device-strip chip refinements.
