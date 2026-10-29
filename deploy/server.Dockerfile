# Game server (Fastify): tokens, rooms, game master, world engine, cost ledger.
# Built by `wrangler deploy` with the repo root as context (see wrangler.jsonc image_build_context).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN npm ci --workspace packages/server --workspace packages/shared --include=dev --ignore-scripts
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY tsconfig.base.json ./
WORKDIR /app/packages/server
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
