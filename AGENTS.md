# Working on Summoners

Instructions for coding agents (and humans in a hurry). The README explains the game, the setup, and the
operations; this file is what you need to not break it.

## Shape

npm workspaces, TypeScript everywhere, Node 24, run with `tsx` (no build step for Node packages).

| package | what | entry |
|---|---|---|
| `packages/shared` | zod schemas for world, events, messages, cost, talents; `applyEvent` reducer used by server and clients | `src/index.ts` |
| `packages/server` | Fastify game server: rooms, LiveKit tokens and dispatch, game master (Claude + tools), combat engine, bribes, progression, cost ledger, session log | `src/index.ts` |
| `packages/agents` | LiveKit agents worker: one demon per player (Silero VAD, Deepgram, Claude, Cartesia), keyless mocks | `src/worker.ts`, `src/demon.ts` |
| `packages/web` | Vite + React + React Three Fiber client | `src/main.tsx` |
| `packages/harness` | synthetic players, scenarios, real-browser runs, reports | `src/cli.ts` |
| `deploy/` | Cloudflare Worker, Dockerfiles, LiveKit install script for the Linode | `worker.ts`, `wrangler.jsonc` at root |
| `scripts/` | secrets, hearts, session reports, Claude bench | |

Every change to the world goes through a `WorldEvent` (shared/events.ts) applied by `applyEvent`; the server
is authoritative, clients and bots mirror. If you add state, add it to the schema, the reducer, and the event.

## Commands

```bash
npm run dev                 # server + agents worker + web, needs the local LiveKit container (docker compose up -d)
npm run typecheck           # all packages; also: npm run typecheck:deploy for the Worker
npm test                    # vitest: schemas, world engine, mic time, cost ledger, bribes
npm run harness -- <scenario>   # smoke | duel | mic-time | voice [--voice] | versus | explore | browser [--headed]
npm run deploy              # build client, build+push both container images, deploy the Worker (needs Docker)
node scripts/session-report.mjs [room]   # what happened in a real session, from D1
```

Before claiming anything works: `npm run typecheck && npm test`, then the harness scenario that covers it.
For client or game-flow changes run `browser`; for engine changes run `versus` (`HEART_HP=400` on the server
for short matches). Against production: `GAME_SERVER_URL=https://games.greg.kitchen/summoners WEB_URL=... npm run harness -- browser`.

## Rules that are not obvious from the code

- Keys live in `.env` (gitignored). Never print, echo, or paste a key value; move them by file or pipe
  (`scripts/secrets-json.mjs`, `scripts/pull-livekit-keys.sh`). Every stage has a keyless mock, so missing keys
  are never a reason to stop working.
- The agents worker does not hot reload. Restart `npm run dev` after editing `packages/agents`.
- On this Windows box npm drops native optional packages (rolldown, lightningcss, esbuild) after installing
  anything; the fix is `rm -rf node_modules package-lock.json && npm install` with the dev stack stopped.
- Claude calls: Opus 5.5 for the game master, Sonnet 5.5 for demons, effort `low`, server-side fallbacks on,
  one game-master call per round with the history cached by a breakpoint on its last block. Sonnet and Haiku
  take `thinking: between_tools` (off); Opus rejects it. Never let thinking eat a small `max_tokens`.
- Rooms, scores, XP, pictures live in the game server's memory. A deploy ends every live match. The session
  log in D1 is the only thing that survives.
- Production secrets reach a container only when its process starts, and Durable Objects keep old code and
  secrets until evicted: after rotating anything, bump `INSTANCE_GEN` in `wrangler.jsonc` and deploy. After a
  deploy, wait for `/api/health` and give the container rollout a couple of minutes before testing.
- The agents image must keep `ca-certificates`; without it the native LiveKit engine cannot open TLS and demons
  die silently. `GET /api/rooms/ROOM/debug` (with `x-game-secret`) is where "no demon" problems show first.
- Hearts are static pictures in `packages/web/public/hearts`; repaint with `node scripts/paint-hearts.mjs <team>`.
- Chroma key: sprites sample their own border for the key colour and compare chromaticity. If a picture shows
  a square, the model ignored the magenta prompt; the fix is in the shader or the prompt, not in the server.
- Costs are metered at list prices into `CostLedger`; anything that calls a paid API must report usage
  (server: `recordUsage`; demons: the metrics handler in `demon.ts`). Mocks are free and unmetered.

## Where things are decided

- Game rules (teams, hearts, engine constants, points): `packages/shared/src/world.ts` and
  `packages/server/src/world/state.ts`.
- Talents: `packages/shared/src/talents.ts`; effects applied in `state.ts` (`summon`, `attack`, `regrow`).
- Bribes: `packages/server/src/temptations.ts`.
- Game master prompt and tools: `packages/server/src/gm/`; the Haiku router that reads every line first is `gm/router.ts`
  (chatter never reaches Opus; talent picks by voice are applied in `rooms.ts` from the router's intent).
- Demon persona and voice: `packages/server/src/personas.ts` (Cartesia voice ids), `packages/agents/src/meta.ts`.
- Audio routing (who hears whom): `packages/web/src/room/useSubscriptions.ts`, `RoomMicButton.tsx`,
  `packages/server/src/micTime.ts`.

## Style

Plain TypeScript, no classes where a function does, comments say why not what, one sentence each. Prettier
defaults, 2-space, double quotes, trailing commas. Tests next to the code as `*.test.ts`.
