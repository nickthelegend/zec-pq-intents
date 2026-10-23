# syntax=docker/dockerfile:1
# Yaksok desk image, read-only: serves a published testnet record (PQI_PUBLISHED) over HTTP.
# No seeds, wallets or keys are in the image; POST /api/intents answers Setup required.
FROM node:22-bookworm-slim AS build
ENV CI=true
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/node/package.json packages/node/
RUN pnpm install --frozen-lockfile --filter "@pqi/node..."
COPY packages/protocol packages/protocol
COPY packages/node packages/node
RUN pnpm --filter @pqi/protocol build && pnpm --filter @pqi/node build \
 && pnpm install --frozen-lockfile --prod --filter "@pqi/node..."

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production PQI_HOST=0.0.0.0 PQI_PORT=8404 PQI_PUBLISHED=/app/deployments/testnet-pass3.json
WORKDIR /app
COPY --from=build /app ./
COPY deployments ./deployments
USER node
EXPOSE 8404
CMD ["node", "packages/node/dist/serve.js"]
