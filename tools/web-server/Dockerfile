# Self-hosted deployment image (docs/CLOUD_SYNC.md "one codebase, two deploy
# targets"). Build context is tools/ — the app imports the session parser from
# ../web-flasher and copies the flasher's static assets at build time:
#   docker build -f web-server/Dockerfile .
# Normally driven by web-server/docker-compose.yml.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app/web-server
COPY web-server/package.json web-server/pnpm-lock.yaml web-server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web-flasher /app/web-flasher
COPY web-server .
RUN pnpm build

FROM node:22-alpine
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app/web-server
COPY --from=build /app/web-server .
EXPOSE 3000
# prepare-static already ran inside `pnpm build`; run next start directly so
# the prebuild hook doesn't re-run (web-flasher isn't in this stage).
CMD ["pnpm", "exec", "next", "start"]
