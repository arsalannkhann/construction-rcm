# Not built or run as part of this repository's verification (no Docker daemon
# was available). Provided as the intended production shape.
FROM node:20-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY scripts/copy-pdf-worker.mjs scripts/copy-pdf-worker.mjs
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/public public
COPY . .
RUN pnpm build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/.next .next
COPY --from=build /app/public public
COPY --from=build /app/drizzle drizzle
COPY --from=build /app/package.json /app/next.config.ts ./
# Uploaded documents and exports. Mount a volume here.
ENV RCM_DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["pnpm", "start"]
