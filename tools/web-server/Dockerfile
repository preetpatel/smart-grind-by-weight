# Self-hosted deployment image (docs/CLOUD_SYNC.md "one codebase, two deploy
# targets"). The app is fully self-contained: UI, analytics dashboard, sync
# API and firmware release proxy. Normally driven by docker-compose.yml.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app .
EXPOSE 3000
CMD ["pnpm", "exec", "next", "start"]
