# Production image: the web app and its document-processing queue in one
# process, talking to PostgreSQL through DATABASE_URL. See docs/operations.md.
FROM node:20-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY scripts/copy-pdf-worker.mjs scripts/copy-pdf-worker.mjs
RUN pnpm install --frozen-lockfile

# Runtime dependencies only: no compilers, test tools or embedded test database.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
COPY scripts/copy-pdf-worker.mjs scripts/copy-pdf-worker.mjs
RUN pnpm install --frozen-lockfile --prod

FROM base AS build
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/public public
COPY . .
RUN pnpm build

FROM node:20-slim AS run
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/.next .next
COPY --from=build /app/public public
COPY --from=build /app/drizzle drizzle
COPY --from=build /app/package.json /app/next.config.ts ./
# Only used when documents are kept on disk (RCM_STORAGE=disk, or no DATABASE_URL).
# With DATABASE_URL set, documents are stored in PostgreSQL and this stays empty.
ENV RCM_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/next", "start"]
