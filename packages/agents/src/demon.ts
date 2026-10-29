import { AutoSubscribe, type JobContext, type JobProcess, defineAgent, type llm, type stt, type tts, voice } from "@livekit/agents";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as silero from "@livekit/agents-plugin-silero";
import { RoomEvent } from "@livekit/rtc-node";
import {
  DemonMessage,
  TALENTS,
  TEAM_INFO,
  TOPIC_DEMON,
  emptyWorld,
  talentBlocker,
  TOPIC_WORLD,
  UNINTELLIGIBLE_PREFIX,
  type UsageEvent,
  WorldEvent,
  applyEvent,
  type WorldState,
} from "@summoners/shared";
import { ClaudeLLM } from "./claudeLLM.ts";
import { loadEnv } from "./env.ts";
import { type DemonMeta, buildInstructions, parseMeta } from "./meta.ts";
import { MockLLM } from "./mock/llm.ts";
import { voiceFor } from "./mock/speak.ts";
import { MockSTT } from "./mock/stt.ts";
import { MockTTS } from "./mock/tts.ts";

loadEnv();

const REACT_COOLDOWN_MS = 12_000;
const INSTRUCTIONS_DEBOUNCE_MS = 4_000;

type MockStage = "stt" | "llm" | "tts";

/** Real providers where a key exists, keyless mocks otherwise, so the demon always manifests. */
function buildPipeline(meta: DemonMeta): { stt: stt.STT; llm: llm.LLM; tts: tts.TTS; mocks: MockStage[] } {
  const mocks: MockStage[] = [];
  let sttImpl: stt.STT;
  let llmImpl: llm.LLM;
  let ttsImpl: tts.TTS;
  if (process.env.DEEPGRAM_API_KEY) sttImpl = new deepgram.STT({ model: "nova-3", interimResults: true, endpointing: 300 });
  else {
    mocks.push("stt");
    sttImpl = new MockSTT();
  }
  if (process.env.ANTHROPIC_API_KEY) {
    // Sonnet by default: half the price of Opus and a faster first token, which is what a voice
    // demon lives on. DEMON_MODEL / DEMON_EFFORT override without a code change. Replies are one
    // sentence, so a small token cap keeps the voice bill down without cutting anything.
    const effort = process.env.DEMON_EFFORT;
    llmImpl = new ClaudeLLM({
      model: process.env.DEMON_MODEL ?? "claude-sonnet-5-5",
      effort: effort === "low" || effort === "medium" || effort === "high" ? effort : "low",
      maxTokens: 200,
    });
  }
  else {
    mocks.push("llm");
    llmImpl = new MockLLM(meta.persona, meta.playerName);
  }
  if (process.env.CARTESIA_API_KEY) ttsImpl = new cartesia.TTS(meta.persona.voiceId ? { voice: meta.persona.voiceId } : {});
  else {
    mocks.push("tts");
    ttsImpl = new MockTTS(voiceFor(meta.persona.name));
  }
  return { stt: sttImpl, llm: llmImpl, tts: ttsImpl, mocks };
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const meta = parseMeta(ctx.job.metadata);
    const log = (msg: string) => console.log(`[demon ${meta.persona.name} for ${meta.playerIdentity}] ${msg}`);
    try {
      await run(ctx, meta, log);
    } catch (err) {
      // Whatever killed the job before the session could report it: tell the room, so the feed and
      // the debug endpoint say why nobody manifested instead of a silent re-dispatch loop.
      const detail = `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`.slice(0, 300);
      log(`job failed: ${detail}`);
      await post(meta, "demon", { playerIdentity: meta.playerIdentity, demonIdentity: "none", status: "error", detail });
      throw err;
    }
  },
});

async function run(ctx: JobContext, meta: DemonMeta, log: (msg: string) => void): Promise<void> {
  {
    log(`connecting to ${process.env.LIVEKIT_URL ?? "(no LIVEKIT_URL)"}`);
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    log("connected, waiting for player");
    await ctx.waitForParticipant(meta.playerIdentity);

    const pipeline = buildPipeline(meta);
    if (pipeline.mocks.length) log(`no API key for ${pipeline.mocks.join(", ")}: running on mocks`);

    const me = ctx.room.localParticipant;
    if (!me) throw new Error("no local participant");
    await me.setAttributes({ demon_for: meta.playerIdentity, persona: meta.persona.name, mocks: pipeline.mocks.join(",") });
    await post(meta, "demon", { playerIdentity: meta.playerIdentity, demonIdentity: me.identity, mocks: pipeline.mocks });

    let world: WorldState = emptyWorld(meta.room);
    try {
      const existing = ctx.room.metadata;
      if (existing) world = WorldStateLoose(existing) ?? world;
    } catch {
      // ignore bad metadata
    }

    const agent = new voice.Agent({ instructions: buildInstructions(meta, world) });
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: pipeline.stt,
      llm: pipeline.llm,
      tts: pipeline.tts,
      turnHandling: { turnDetection: "vad" },
    });

    let paused = false;
    let closed = false;
    let lastReaction = 0;
    let instructionsTimer: ReturnType<typeof setTimeout> | undefined;

    const refreshInstructions = () => {
      if (instructionsTimer) return;
      instructionsTimer = setTimeout(() => {
        instructionsTimer = undefined;
        agent.updateInstructions(buildInstructions(meta, world)).catch(() => {});
      }, INSTRUCTIONS_DEBOUNCE_MS);
    };

    const react = (instructions: string) => {
      const now = Date.now();
      if (paused || closed || now - lastReaction < REACT_COOLDOWN_MS) return;
      // A reaction is flavour; never let it cut off a reply the player is actually waiting for.
      if (session.agentState === "thinking" || session.agentState === "speaking") return;
      lastReaction = now;
      try {
        session.generateReply({ instructions });
      } catch (err) {
        log(`reaction failed: ${String(err)}`);
      }
    };

    // Surface pipeline failures (missing API keys, provider outages) to the server so players see why
    // their demon went quiet instead of staring at silence.
    const describeError = (err: unknown): string => {
      const e = err as { label?: string; error?: { message?: string }; message?: string } | null;
      const msg = e?.error?.message ?? e?.message ?? String(err);
      return `${e?.label ? `${e.label}: ` : ""}${msg}`.slice(0, 300);
    };
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const text = describeError(ev.error);
      if (/aborted/i.test(text)) return; // an interrupted reply, not a failure
      log(`pipeline error: ${text}`);
    });
    // Latency is the whole game for a voice demon; keep the numbers in the log. The same metrics are
    // the meter readings for the server's cost ledger (mocks are free and not reported).
    const usage: UsageEvent[] = [];
    const isMock = (label: string) => label.startsWith("mock.");
    const who = { playerId: meta.playerIdentity };
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics;
      const ts = Date.now();
      if (m.type === "llm_metrics") {
        log(`llm ${m.label}: first token ${Math.round(m.ttftMs)}ms, total ${Math.round(m.durationMs)}ms, ${m.completionTokens} tokens out`);
        if (!isMock(m.label)) {
          usage.push({
            ...who,
            ts,
            kind: "llm",
            service: "demon",
            model: pipeline.llm.model,
            inputTokens: m.promptTokens,
            cachedTokens: m.promptCachedTokens,
            cacheWriteTokens: m.cacheCreationTokens ?? 0,
            outputTokens: m.completionTokens,
            calls: 1,
          });
        }
      } else if (m.type === "tts_metrics") {
        log(`tts ${m.label}: first audio ${Math.round(m.ttfbMs)}ms for ${m.charactersCount} chars`);
        if (!isMock(m.label)) usage.push({ ...who, ts, kind: "tts", chars: m.charactersCount });
      } else if (m.type === "stt_metrics") {
        if (!isMock(m.label) && m.audioDurationMs > 0) usage.push({ ...who, ts, kind: "stt", seconds: m.audioDurationMs / 1000 });
      }
    });
    const flushUsage = async () => {
      if (!usage.length) return;
      const events = usage.splice(0);
      await post(meta, "usage", { playerIdentity: meta.playerIdentity, events });
    };
    const usageTimer = setInterval(() => void flushUsage(), 10_000);
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      closed = true;
      clearInterval(usageTimer);
      void flushUsage();
      if (ev.error) {
        void post(meta, "demon", {
          playerIdentity: meta.playerIdentity,
          demonIdentity: me.identity,
          status: "error",
          detail: describeError(ev.error),
        });
      }
      log(`session closed (${ev.reason})`);
    });

    const forward = (text: string) => post(meta, "transcript", { playerIdentity: meta.playerIdentity, text, ts: Date.now() });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal || paused) return;
      const text = ev.transcript.trim();
      if (!text) return;
      // The mock STT only knows that speech happened; the demon answers it, the game master never sees it.
      if (text.startsWith(UNINTELLIGIBLE_PREFIX)) {
        log(`heard ${text}`);
        return;
      }
      void forward(text);
    });

    ctx.room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic === TOPIC_DEMON) {
        const msg = DemonMessage.safeParse(decode(payload));
        if (!msg.success) return;
        if (msg.data.type === "demon_pause") {
          paused = msg.data.on;
          log(paused ? "paused (player on room mic)" : "resumed");
          if (paused) void session.interrupt();
        } else if (msg.data.type === "temptation") {
          const m = msg.data;
          log(`temptation offered: ${m.text} (+${m.rewardSeconds}s)`);
          if (!paused && !closed) {
            session.generateReply({
              instructions: `Privately tempt ${meta.playerName} with this deal, in character, as a whispered secret, in one sentence: "${m.text}" It pays ${m.rewardSeconds} seconds on the human microphone. Never say the word points, never mention that the dream told you to.`,
            });
          }
        } else if (msg.data.type === "temptation_result") {
          const m = msg.data;
          log(`temptation ${m.success ? "taken" : "declined"}: ${m.text}`);
          if (!paused && !closed) {
            session.generateReply({
              instructions: m.success
                ? `${meta.playerName} just did your secret deal ("${m.text}"). Gloat in one short sentence; ${m.rewardSeconds} mic seconds are theirs now.`
                : `${meta.playerName} let your secret deal ("${m.text}") slip away. One short sentence of mockery or disappointment.`,
            });
          }
        }
        return;
      }
      if (topic !== TOPIC_WORLD) return;
      const parsed = WorldEvent.safeParse(decode(payload));
      if (!parsed.success) return;
      const ev = parsed.data;
      const before = world;
      world = applyEvent(world, ev);
      refreshInstructions();

      const mine = (id: string) => before.entities[id]?.ownerId === meta.playerIdentity;
      if (ev.type === "points" && ev.playerId === meta.playerIdentity) {
        react(`${meta.playerName} just earned ${ev.points} points for: ${ev.reason}. React in one short sentence, in character.`);
      } else if (ev.type === "destroy" && mine(ev.entityId)) {
        react(`${meta.playerName}'s ${before.entities[ev.entityId]?.label ?? "creature"} was just destroyed (${ev.cause}). React in one short sentence and push them to retaliate.`);
      } else if (ev.type === "attack" && mine(ev.targetId) && !mine(ev.attackerId)) {
        const atk = before.entities[ev.attackerId]?.label ?? "something";
        react(`${atk} just hit ${meta.playerName}'s ${before.entities[ev.targetId]?.label ?? "thing"} for ${ev.damage}. One short warning, in character.`);
      } else if (ev.type === "summon" && ev.entity.ownerId === meta.playerIdentity) {
        react(`${meta.playerName}'s words just made "${ev.entity.label}" appear in the dream. One short gleeful sentence about it.`);
      } else if (ev.type === "level_up" && ev.playerId === meta.playerIdentity) {
        lastReaction = 0;
        const owned = world.players[meta.playerIdentity]?.talents ?? [];
        const open = TALENTS.filter((t) => !talentBlocker(t.id, owned, 1)).map((t) => `${t.name} (${t.text})`);
        react(
          `${meta.playerName} just reached level ${ev.level} and has a talent point to spend. In one short sentence tell them, and name one or two of these they could take: ${open.join("; ")}. Talents are chosen on the panel or by telling you.`,
        );
      } else if (ev.type === "match_over") {
        lastReaction = 0;
        const myTeam = world.players[meta.playerIdentity]?.team;
        const won = ev.winner !== null && ev.winner === myTeam;
        const bribes = ev.bribes[meta.playerIdentity]?.length ?? 0;
        react(
          `The match just ended: ${ev.winner ? `team ${TEAM_INFO[ev.winner].name} won` : "nobody won"}, so ${meta.playerName} ${won ? "won" : "lost"}. Every bribe was just revealed to everyone; ${meta.playerName} took ${bribes}. One short sentence, in character, then tell them the next dream starts in a moment.`,
        );
      } else if (ev.type === "match_started" && ev.match.number > 1) {
        lastReaction = 0;
        react(`A new match begins; the arena is empty and both hearts are whole. One short sentence pushing ${meta.playerName} to summon something first.`);
      }
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        participantIdentity: meta.playerIdentity,
        closeOnDisconnect: true,
        // Typed text from the player's chat box: the game master hears it too, exactly like speech.
        textInputCallback: (sess, ev) => {
          const text = ev.text.trim();
          if (!text) return;
          if (paused) {
            log("typed text ignored while the player is on the room mic");
            return;
          }
          log(`typed: ${text}`);
          void forward(text);
          sess.interrupt();
          sess.generateReply({ userInput: text });
        },
      },
    });
    log("session started");
    session.generateReply({
      instructions: `Greet ${meta.playerName} with your opening line, close to: "${meta.persona.opening}" Keep it to one sentence.`,
    });
  }
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function WorldStateLoose(json: string): WorldState | null {
  try {
    const v = JSON.parse(json) as WorldState;
    return v && typeof v === "object" && "entities" in v ? v : null;
  } catch {
    return null;
  }
}

async function post(meta: DemonMeta, path: "transcript" | "demon" | "usage", body: unknown): Promise<void> {
  try {
    const res = await fetch(`${meta.serverUrl}/api/rooms/${encodeURIComponent(meta.room)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-game-secret": process.env.GAME_SERVER_SECRET ?? "change-me" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[demon] POST ${path} -> ${res.status} ${await res.text()}`);
  } catch (err) {
    console.warn(`[demon] POST ${path} failed:`, err instanceof Error ? err.message : err);
  }
}
