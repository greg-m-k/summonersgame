# Summoners

A voice-driven multiplayer dream-fight world. Everyone joins a room on webcam and mic. Each player talks
continuously to their own AI demon. A single AI game master hears every player's words at once and makes them
real in a shared 2.5D arena: creatures appear, fight, mutate, the sky changes. Players cannot hear each other
by default. Points earned in the dream buy "mic time": hold the room-mic button and the other humans hear you
while your demon stops listening.

## How it fits together

| Package | Runs as | Does |
|---|---|---|
| `packages/web` | Vite + React + React Three Fiber in the browser | Lobby, video grid, 3D arena, hold-to-talk button, HUD |
| `packages/server` | Fastify on port 8787 | Tokens, room registry, demon dispatch, game master (Claude + tools), world state, mic-time bank, image generation |
| `packages/agents` | `@livekit/agents` worker, one process per demon | Silero VAD, Deepgram STT, Claude (custom adapter), Cartesia TTS; forwards transcripts to the server |
| `packages/shared` | library | zod schemas for the world, events, and messages, plus the `applyEvent` reducer both sides use |

Audio routing (all through LiveKit selective subscription):

- Each player publishes one mic and one camera track. Clients join with `autoSubscribe: false`.
- Everyone subscribes to every camera. Nobody subscribes to anyone else's mic.
- Your demon subscribes only to your mic and publishes a voice track that only you subscribe to.
- Holding the room mic tells the server to unsubscribe your demon from your mic and broadcasts `mic_time`, so the
  other clients subscribe to you. Releasing (or running out of seconds) reverses both.
- The game master never hears audio. It reads the final transcripts the demons forward.

## The game

Two teams, Ash and Tide. Players are dealt to the smaller team as they join. Each team has a heart, a
crystal on its side of the arena. Everything you summon belongs to your team, marches toward the enemy
heart on its own, and fights whatever it meets on the way (nearest enemy within 7 m, else the heart).
Hits land about once a second for a quarter of the attacker's attack stat. When a heart dies the match
ends: winners get 8 points, a result screen shows scores and every bribe each player took, and 15 s
later a fresh match starts with a clean arena.

Points buy mic time: 2 for a kill (3 if the victim was bigger), 1 per 100 damage to the enemy heart, 1 to
3 from the game master for a vivid summon, 8 for winning. Hold the room-mic button to talk to the other
humans: coordinate with your team, bluff the enemy. Your demon stops listening while you do.

Demons are on nobody's side. Every minute or so yours whispers a private deal that pays mic seconds:
kill your own creature, put a given word in your next summon, order your creature to attack a teammate's
thing, say nothing for thirty seconds, sweet-talk the enemy on the mic. Nobody else hears the offer. At
the end of the match every bribe taken is revealed to everyone.

The game master only decides what exists: it turns your words into creatures with stats, transforms,
explicit strikes you order, and world warps. The fighting runs on the server tick without it.

Progression lasts the whole session. Every point is 10 XP; levels come at 100, 250, 450, 700... XP and each
one pays a talent point and 20 s of mic time (a point by itself pays 2 s). The talent tree has three
branches of three tiers, a tier needs the tier below it in the same branch, and it shapes everything you
summon from then on: Fury (Sharp Teeth +20% attack, Bloodlust +30% damage under half hp, Overkill +60% to
hearts), Hide (Thick Hide +25% hp, Regrowth heals 3%/s out of combat, Second Wind survives a first death
at 1 hp), Dream (Silver Tongue +2 mic seconds per point, Echo brings a 40% copy with every summon, Haste
+30% speed). Open the tree with the button under the scoreboard or the T key. Every kill also makes that
creature 10% stronger, shown as stars on its label.

`HEART_HP` (default 1200) sets heart hit points; `HEART_HP=400` makes short matches for testing.

## Setup

Requirements: Node 24+, npm 11+, and either Docker (local LiveKit) or a LiveKit Cloud project.

```bash
npm install
cp .env.example .env   # then fill in the keys below
```

Keys in `.env`:

| Variable | Needed for | Where |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | everything | local Docker defaults are prefilled; or a LiveKit Cloud project |
| `ANTHROPIC_API_KEY` | game master and demon brains (Claude does text only, hence the other keys) | console.anthropic.com |
| `DEEPGRAM_API_KEY` | demons hearing you: streaming speech to text | deepgram.com |
| `CARTESIA_API_KEY` | demons talking: low-latency text to speech | cartesia.ai |
| `FAL_KEY` | summon pictures: the sprites that make the arena look like anything | fal.ai |
| `GAME_SERVER_SECRET` | agents worker authenticating to the server | any random string |

Every key is optional while developing: a missing key swaps that one stage for a keyless mock (see "Mocks"), so
the whole game runs with no keys at all, only worse.

Server-side refusal fallbacks are enabled on every Claude call (`fallbacks: "default"`); a declined request is
re-run on a fallback model inside the same call.

## Mocks: develop without API keys

Each external service has a stand-in that kicks in automatically when its key is missing. `GET /api/health`
reports which stages are real and which are mocked, the feed says so when a demon manifests, and the demon chat
panel shows a `mock` badge.

| Stage | Key | Mock |
|---|---|---|
| Game master | `ANTHROPIC_API_KEY` | scripted: every utterance summons something named after your last words, fights break out, points flow (`GM_MOCK=1` forces it even with a key) |
| Demon brain | `ANTHROPIC_API_KEY` | scripted persona replies that echo your words and react to points, kills, hits, and summons |
| Demon ears | `DEEPGRAM_API_KEY` | duration-only recognition: the VAD still segments your speech and the demon answers, but it only knows that you spoke, not what you said. Type in the demon chat box to be understood; typed text reaches the game master too |
| Demon voice | `CARTESIA_API_KEY` | Windows speech API voices (one per persona), or pitched bleeps on other platforms |
| Sprites | `FAL_KEY` | procedurally drawn SVG stickers on the same magenta key, so the placeholder-then-picture swap is identical |

The typed chat box exists with real keys too; whatever you type goes to your demon and to the game master exactly
like speech.

## Run

Local LiveKit server (Docker Desktop must be running):

```bash
docker compose up -d
```

Then, in one terminal:

```bash
npm run dev
```

That starts the game server (8787), the agents worker, and the web client (5173). Open http://localhost:5173,
pick a name and a room code, and share the code. Headphones are strongly recommended; the demon voices and
your own mic are in the same room.

For friends over the internet, use a LiveKit Cloud project instead of Docker: set `LIVEKIT_URL` to the
`wss://` URL and the API key and secret from the project, keep running the worker locally, and expose the web
app with a tunnel. The free tier allows five concurrent agent sessions, so five players.

### Dev tricks

- `GM_MOCK=1` forces the scripted game master even when `ANTHROPIC_API_KEY` is set (it is automatic without
  the key). Good for testing the 3D pipeline and mic time without spending tokens.
- Simulate speech without a demon:

  ```bash
  curl -X POST http://localhost:8787/api/rooms/ROOM/transcript \
    -H "content-type: application/json" -H "x-game-secret: $GAME_SERVER_SECRET" \
    -d '{"playerIdentity":"greg-ab12","text":"summon a flaming whale","ts":0}'
  ```

- `GET /api/rooms/ROOM/state` dumps the authoritative world.
- Two Chrome windows with `--use-fake-device-for-media-stream` make a two-player test on one machine.

## Tests

```bash
npm test          # vitest: shared schemas, world reducer, mic-time bank
npm run typecheck
```

## Known gaps

- The demon re-attaching after the server re-subscribes it to your mic is untested on the Node agents SDK; if a
  demon goes deaf after mic time, the fallback is to restart its session.
- Opus with thinking on may be slow for a voice demon. Measure first-token latency; swapping the demon model is a
  one-line change in `packages/agents/src/demon.ts`.
- Chroma keying assumes the image model obeys the magenta-background instruction; pinkish subjects can fringe.

- `DEMON_RESPECT_LOAD=1` restores the agents worker's CPU-load check (off by default so a busy dev machine does not silently drop dispatches).
- If a demon's pipeline fails (bad or missing key), the feed shows `<persona> fails to manifest for <player>: <reason>`.
- A demon that never registers (joined before the worker was up) or whose job ended (page refresh, worker
  restart) is dispatched again by the roster poll, up to three times per player, 15 s apart.
- Latency and cost knobs: `GM_MODEL` (default `claude-opus-5-5`), `DEMON_MODEL` (default `claude-sonnet-5-5`), `GM_EFFORT` and `DEMON_EFFORT` (default `low`), `GM_ROUND_MS` (default 7000, the gap between game-master rounds).
  Measured on Opus 5.5 at low effort: game-master round 2 to 7 s per model call, demon first token 1.6 to
  2.2 s. The agents worker logs `llm ... first token` and `tts ... first audio` per reply; the server logs
  `[gm] round` per round. Try `DEMON_MODEL=claude-sonnet-5-5` if the demons feel slow.

## Cost

Every meter is priced live at list prices and summed per room, per player, and per service (game master,
demon brains, speech-to-text seconds, text-to-speech characters, pictures). Measured: about $0.15 per
player-minute of lively play, so roughly $10 per player-hour, more than half of it the game master.

- `GET /api/rooms/ROOM/cost` and `GET /api/cost`: totals, by player, by service, and a $/hour pace over the
  last five minutes.
- The scoreboard shows `$spent · $pace/h` and each player's share; every tile shows its player's share.
- The server logs `[cost ROOM] ...` once a minute while money moves.
- Every harness report ends with a cost table, and the explore critic is told what the run cost.
- `ROOM_BUDGET_USD=20` pauses the game master and silences every demon in a room once its estimate crosses
  the line (the feed says so). Mic time keeps working.
- Prices live in `packages/shared/src/cost.ts`; `PRICE_STT_PER_MIN`, `PRICE_TTS_PER_CHAR`, `PRICE_IMAGE_EACH`
  override the third-party rates. Mocked stages cost nothing and are not metered.

## Deploy (Cloudflare)

Live at https://games.greg.kitchen/summoners. One Worker (`deploy/worker.ts`, `wrangler.jsonc`) serves the
built client and proxies `/summoners/api/*` to the game server, which runs as a Cloudflare Container next to
the demons container (the LiveKit agents worker). The demons are woken whenever someone joins and kept awake
by a five-minute cron while rooms exist; both containers sleep after twenty idle minutes, so an idle deployment
costs nothing beyond the Workers Paid plan.

```bash
npm run deploy           # build the client, build and push both images, deploy (needs wrangler login + Docker)
npm run deploy:secrets   # push the keys in .env to the Worker, which hands them to the containers
```

Pushing to `main` does the same through `.github/workflows/deploy.yml`, reading the keys from GitHub repository
secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and the same names as `.env`).

LiveKit cannot run on Cloudflare (WebRTC media is UDP; Containers only take HTTP), so it is self-hosted on a
Linode with a public IP: `deploy/livekit-linode.sh` installs `livekit-server` and Caddy (TLS) and opens the
firewall; `scripts/pull-livekit-keys.sh` copies the generated keys into `.env`, the Worker, and GitHub.

Operating it:

- Secrets reach a container only when its process starts, and Durable Objects keep old code and secrets until
  evicted. After rotating secrets, bump `INSTANCE_GEN` in `wrangler.jsonc` and deploy (new instances, the old
  ones drain). `POST /summoners/_ops/restart` with the `x-game-secret` header restarts the current ones.
- `GET /summoners/api/rooms/ROOM/debug` with the same header shows each player's demon dispatch, re-dispatch
  count, and the last error the demon reported. That is where "no demon" problems show up first.
- The agents image needs `ca-certificates`; without them the native LiveKit engine cannot open TLS.

## Session logs: learn from real games

Every room ships everything that happens to Cloudflare D1 through the Worker (`/_ops/log`): world events,
what each player said, what each demon said, demon failures, bribes offered and taken, game-master round
timings, per-stage latency from the demon pipeline (Deepgram end-of-turn, Claude first token, Cartesia first
audio), and a cost snapshot per minute. Locally, with no Worker, the same stream goes to
`packages/server/logs/<room>.jsonl`.

```bash
node scripts/session-report.mjs            # recent sessions: room, start, minutes, events, utterances
node scripts/session-report.mjs static-925 # writes reports/static-925.md
```

The report has players, numbers, matches and bribes, a latency table (median and p90 per stage, then per
utterance: how long until the game master finished, until the world changed, until the demon replied), every
summon with its stats, and the full timeline. Raw rows: `GET /summoners/_ops/sessions` and
`GET /summoners/_ops/rooms/ROOM/log` with the `x-game-secret` header.

## Harness: drive the game with synthetic players

`packages/harness` joins real rooms with bot players, speaks, watches everything, and writes a report
(`packages/harness/runs/<timestamp>-<scenario>/report.md` plus `run.json` and any recorded demon audio).

```bash
npm run dev                          # in one terminal: server, agents worker, web
npm run harness -- smoke             # one player: join, speak, points, room mic
npm run harness -- duel              # two players summon, attack, transform, warp
npm run harness -- mic-time          # proves B hears A only while A holds the mic (real audio frames)
npm run harness -- explore --players 3 --rounds 4   # Claude plays the players, a critic reviews the log
npm run harness -- voice --voice     # real speech through the demon pipeline, plus typed chat; works on mocks
npm run harness -- versus            # four players, two teams: autonomous fighting, bribes, a heart falls, next match
npm run harness -- browser --headed  # two real Chrome windows with fake camera and mic, screenshots per step
```

- Bots connect with `@livekit/rtc-node`, mirror the world from the data channel, read demon speech from the
  `lk.transcription` text stream, and record the demon's audio to WAV.
- `--voice` turns utterances into audio with the Windows speech API (offline, cached under `fixtures/tts`) and
  streams them on the bot's mic track, so Silero, Deepgram, Claude, and Cartesia all run for real. On the mocks
  the same run proves VAD turn-taking and the demon's voice track; the scenario adapts its checks to whatever
  `/api/health` says is mocked.
- Bots can also `whisper()`: typed text on the `lk.chat` topic, the same path as the chat box in the UI.
- Without `ANTHROPIC_API_KEY` the explore players use scripted lines and the critic is statistical; with the
  key, each player is a Claude persona and the critic writes a design review citing timestamps.
- `--browser` needs Chrome installed (Playwright uses it via `channel: "chrome"`); otherwise run
  `npx playwright install chromium` once.
- Exit code is non-zero when any check fails, so the harness works in CI against a mock game master (`GM_MOCK=1`).
