# Grinder Web App

One Next.js app — strict TypeScript, Biome, pnpm — serving everything web for
the grinder (design: `docs/CLOUD_SYNC.md`):

1. **The device UI** (`/`) — Get Started (USB install via esp-web-tools),
   Update (BLE OTA), WiFi & Sync provisioning, and Diagnostics, with the
   shared device strip above every page.
2. **The analytics dashboard** (`/analytics`) — full grind analysis from a
   BLE pull or the cloud store (single-session, compare, multi-session,
   trends, device health), rendered with Plotly.
3. **The cloud sync API** — `/api/stores/...`: store creation/claiming, the
   device manifest handshake, raw session-blob ingest with content-hash dedup,
   health snapshots, and read endpoints for the dashboard and Python tooling.
4. **The firmware release proxy** — `/api/firmware[/tag/asset]` lists GitHub
   releases and streams their assets same-origin, replacing the old GitHub
   Pages deployment and its CI asset copying entirely.

## Development

```bash
pnpm install
pnpm dev                       # Next on :3000
DATABASE_URL=postgres://... pnpm dev   # with a database for the API routes
pnpm test                      # vitest against in-process PGlite Postgres
pnpm typecheck                 # strict TypeScript
pnpm lint                      # Biome (lint + format check); lint:fix / format to write
```

`lib/parser.ts` is the single JS/TS parser for the firmware's session files,
shared by the browser dashboard and the server's ingest validation; the
Python parser (`tools/ble/grinder-ble.py`) is the only other consumer — keep
both aligned with `src/logging/grind_logging.h` (see `tools/ble/CLAUDE.md`).

Drizzle migrations live in `drizzle/` and are generated from `lib/schema.ts`
with `pnpm db:generate`. They are applied automatically on first database use
per process (serverless-friendly), both in production and in tests.

## Deploying

**Hosted (Vercel):** set the project root to `tools/web-server` and provide
`DATABASE_URL` (Neon / Vercel Postgres). Session blobs are stored as Postgres
`bytea` — no separate blob store.

**Self-hosted (Docker):**

```bash
cd tools/web-server
docker compose up -d           # app on :3000 + Postgres with a named volume
```

Point the flasher's WiFi & Sync provisioning at `http://<host>:3000`. The
compose file disables the per-store session quota (`SYNC_SESSION_QUOTA=0`).
Put a reverse proxy (Caddy, Tailscale, nginx) in front for TLS if the server
is reachable beyond your LAN.

## Limits (env-overridable, see `lib/config.js`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYNC_MAX_SESSION_BYTES` | 65536 | Reject larger session uploads |
| `SYNC_MAX_SNAPSHOT_BYTES` | 4096 | Reject larger health snapshots |
| `SYNC_SESSION_QUOTA` | 10000 | Per-store cap; oldest rotate out (0 = off) |
| `SYNC_UPLOADS_PER_HOUR` | 200 | Per-store ingest rate limit |
| `SYNC_STORES_PER_IP_PER_DAY` | 20 | Store-creation rate limit |
| `SYNC_PROVISIONAL_TTL_HOURS` | 48 | GC window for stores with no uploads |
