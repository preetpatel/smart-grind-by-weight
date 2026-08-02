# Grinder Web Server

One Next.js app serving three things (design: `docs/CLOUD_SYNC.md`):

1. **The web flasher** — the existing static site from `tools/web-flasher`,
   copied verbatim into `public/` at build time by `scripts/prepare-static.mjs`
   (the flasher stays canonical in its own directory; `public/` is gitignored).
2. **The analytics dashboard** — the flasher's Analytics tab, backed by either
   BLE (as before) or a cloud store.
3. **The cloud sync API** — `/api/stores/...`: store creation/claiming, the
   device manifest handshake, raw session-blob ingest with content-hash dedup,
   health snapshots, and read endpoints for the dashboard and Python tooling.

## Development

```bash
pnpm install
pnpm dev                       # copies flasher assets, starts Next on :3000
DATABASE_URL=postgres://... pnpm dev   # with a database for the API routes
pnpm test                      # vitest against in-process PGlite Postgres
pnpm lint
```

Drizzle migrations live in `drizzle/` and are generated from `lib/schema.js`
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
