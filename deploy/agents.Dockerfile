# Demons: the LiveKit agents worker (Silero VAD, Deepgram, Claude, Cartesia). One process per demon.
# Built by `wrangler deploy` with the repo root as context (see wrangler.jsonc image_build_context).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/agents/package.json packages/agents/
RUN npm ci --workspace packages/agents --workspace packages/shared --include=dev
COPY packages/shared packages/shared
COPY packages/agents packages/agents
COPY tsconfig.base.json ./
WORKDIR /app/packages/agents
# Pull the VAD and turn-detection model files into the image so a cold start does not download them.
RUN npx tsx src/worker.ts download-files || true
EXPOSE 8081
CMD ["npx", "tsx", "src/worker.ts", "start"]
