# Grinder Web App

One Next.js app — strict TypeScript, Biome, pnpm — serving everything web for
the grinder (design: `docs/CLOUD_SYNC.md`):

1. **The device UI** (`/`) — Get Started (USB install via esp-web-tools),
   Update (BLE OTA), WiFi & Sync provisioning, and Diagnostics, with the
   shared device strip above every page.
2. **The analytics dashboard** (`/analytics`) — full grind analysis from a
   BLE pull or the cloud store (single-session, compare, multi-session,
   trends, device health), rendered with Plotly.
3. **Accounts** (`/signin`, `/account`) — Better Auth (email/password,
   passkeys, GitHub when configured). Cloud stores belong to accounts, so
   dashboards follow the user to any signed-in browser; read-only `#store=`
   share links need no account.
4. **The cloud sync API** — `/api/stores/...`: owner-session store management,
   the device manifest handshake, raw session-blob ingest with content-hash
   dedup, health snapshots, and key-authed read endpoints for share links and
   the Python tooling.
5. **The firmware release proxy** — `/api/firmware[/tag/asset]` lists GitHub
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
per process (serverless-friendly), both in production and in tests. The
Better Auth tables (`lib/auth-schema.ts`) were transcribed from
`@better-auth/cli generate` — regenerate and diff when upgrading better-auth.

## Auth model (summary — full design in `docs/CLOUD_SYNC.md`)

- Creating and managing cloud stores requires a signed-in account; every
  store has an `owner_id` from birth.
- The device authenticates uploads with its `upload_key` (stored hashed;
  rotated on every provision — the server never holds a usable write
  credential at rest).
- `view_key` powers read-only dashboard share links and the BLE
  claim-by-possession flow; it is deliberately semi-public.
- Email/password has **no password reset** (no mail service). The UI pushes
  linking GitHub or adding a passkey as the recovery path.

## Deploying

**Hosted (Vercel):** set the project root to `tools/web-server` and provide
the environment below (Neon / Vercel Postgres for `DATABASE_URL`). Session
blobs are stored as Postgres `bytea` — no separate blob store.

**Self-hosted (Docker):**

```bash
cd tools/web-server
BETTER_AUTH_SECRET=$(openssl rand -hex 32) docker compose up -d
```

Point the flasher's WiFi & Sync provisioning at `http://<host>:3000`. The
compose file disables the per-store session quota (`SYNC_SESSION_QUOTA=0`).
Put a reverse proxy (Caddy, Tailscale, nginx) in front for TLS if the server
is reachable beyond your LAN — passkeys and Web Bluetooth both need a secure
context anyway.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `BETTER_AUTH_SECRET` | yes (prod) | ≥32-char random secret for session cookies (`openssl rand -hex 32`) |
| `BETTER_AUTH_URL` | for GitHub/passkeys | Canonical origin, e.g. `https://coffeegrinder.preetpatel.com` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | Enables the "Continue with GitHub" button. OAuth callback: `{BETTER_AUTH_URL}/api/auth/callback/github` |

## Limits (env-overridable, see `lib/config.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYNC_MAX_SESSION_BYTES` | 65536 | Reject larger session uploads |
| `SYNC_MAX_SNAPSHOT_BYTES` | 4096 | Reject larger health snapshots |
| `SYNC_SESSION_QUOTA` | 10000 | Per-store cap; oldest rotate out (0 = off) |
| `SYNC_UPLOADS_PER_HOUR` | 200 | Per-store ingest rate limit |
| `SYNC_STORES_PER_USER` | 20 | Stores per account (a store ≈ one grinder) |
