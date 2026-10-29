import Anthropic from "@anthropic-ai/sdk";
import type { World } from "../world/state.ts";
import { GM_SYSTEM_PROMPT } from "./prompt.ts";
import { type Intent, IntentRouter, mockClassify } from "./router.ts";
import { makeGmTools } from "./tools.ts";

export interface Utterance {
  playerId: string;
  name: string;
  text: string;
  ts: number;
}

export interface GmUsage {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  calls: number;
  /** Players whose words were in the round, for splitting the bill. */
  players: string[];
}

export interface GmOptions {
  model?: string;
  effort?: "low" | "medium" | "high";
  /** Minimum gap between rounds in ms. */
  minIntervalMs?: number;
  maxHistoryMessages?: number;
  enabled?: boolean;
  /** Token usage per round, summed over every model call in it. */
  onUsage?: (usage: GmUsage) => void;
  /** What the router decided about each line, before (or instead of) a round. */
  onIntent?: (u: Utterance, intent: Intent) => void;
  /** Round timing for the session log: when the batch was sent and how long Claude took. */
  onRound?: (round: { utterances: number; waitedMs: number; durationMs: number; tools: number }) => void;
}

type Msg = Anthropic.Beta.BetaMessageParam;

/**
 * The game master: batches player utterances into rounds and lets Claude act on the world
 * through tools. One round in flight per room; utterances arriving mid-round wait for the next.
 */
export class GmEngine {
  private client = new Anthropic();
  private tools: ReturnType<typeof makeGmTools>;
  private history: Msg[] = [];
  private pending: Utterance[] = [];
  private running = false;
  private lastRound = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private model: string;
  private effort: "low" | "medium" | "high";
  private minIntervalMs: number;
  private maxHistory: number;
  private enabled: boolean;

  constructor(
    private world: World,
    opts: GmOptions = {},
  ) {
    this.tools = makeGmTools(world);
    // Opus with thinking takes 4 to 6 s per round at medium effort; low keeps rounds snappy and the
    // tool calls are simple. GM_MODEL / GM_EFFORT override without a code change.
    this.model = opts.model ?? process.env.GM_MODEL ?? "claude-opus-5-5";
    this.effort = opts.effort ?? effortFromEnv(process.env.GM_EFFORT, "low");
    // Rounds batch everything said since the last one; a longer gap means fewer, richer, cheaper rounds.
    this.minIntervalMs = opts.minIntervalMs ?? (Number(process.env.GM_ROUND_MS) || 7000);
    this.maxHistory = opts.maxHistoryMessages ?? 24;
    this.onUsage = opts.onUsage;
    this.onRound = opts.onRound;
    this.onIntent = opts.onIntent;
    this.enabled = opts.enabled ?? Boolean(process.env.ANTHROPIC_API_KEY);
    this.mock = process.env.GM_MOCK === "1" || !this.enabled;
    this.router = this.mock ? null : new IntentRouter();
    if (!this.mock) console.log(`[gm] ${this.model} at effort ${this.effort}`);
    if (process.env.GM_MOCK === "1") console.warn("[gm] GM_MOCK=1: scripted game master, no Claude calls");
    else if (!this.enabled) console.warn("[gm] ANTHROPIC_API_KEY missing: scripted game master (every utterance summons, fights break out)");
  }

  private mock: boolean;
  private onUsage: ((usage: GmUsage) => void) | undefined;
  private onRound: GmOptions["onRound"];
  private onIntent: GmOptions["onIntent"];
  private router: IntentRouter | null = null;
  private paused = false;
  /** Tool results of the last round, waiting to open the next round's user turn. */
  private pendingResults: Anthropic.Beta.BetaUserMessageParam | null = null;

  /** "mock" when scripted (forced or keyless), "claude" otherwise. */
  get mode(): "mock" | "claude" {
    return this.mock ? "mock" : "claude";
  }

  /** A paused game master drops every utterance (budget reached). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.pending = [];
  }

  push(u: Utterance): void {
    if (this.paused) {
      console.log(`[gm:paused] ${u.name}: ${u.text}`);
      return;
    }
    void this.route(u);
  }

  /**
   * The cheap reader goes first: chatter stops here, talent picks are handed to the room, and only
   * lines that change the dream are queued for an Opus round.
   */
  private async route(u: Utterance): Promise<void> {
    let intent: Intent;
    if (this.router) {
      try {
        const r = await this.router.classify(u.text);
        intent = r.intent;
        if (r.usage) this.onUsage?.({ ...r.usage, calls: 1, players: [u.playerId] });
      } catch (err) {
        console.warn("[gm] router failed, treating as a summon:", err instanceof Error ? err.message : err);
        intent = { kind: "summon", talentId: null, gist: u.text.slice(0, 80) };
      }
    } else intent = mockClassify(u.text);
    this.onIntent?.(u, intent);
    if (intent.kind === "chatter" || intent.kind === "talent") {
      console.log(`[gm:${intent.kind}] ${u.name}: ${u.text}`);
      return;
    }
    if (this.mock) {
      this.mockRound(u);
      return;
    }
    this.pending.push(u);
    this.schedule();
  }

  private schedule(): void {
    if (this.running || this.timer) return;
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastRound));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.round();
    }, wait);
  }

  private async round(): Promise<void> {
    if (this.running || this.pending.length === 0) return;
    this.running = true;
    const batch = this.pending.splice(0);
    this.lastRound = Date.now();
    const started = Date.now();
    try {
      const prompt = formatRound(batch, this.world.summaryForGM());
      const messages = this.buildMessages(prompt);
      const runner = this.client.beta.messages.toolRunner({
        model: this.model,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.effort },
        system: [{ type: "text", text: GM_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: this.tools,
        messages,
        max_iterations: 1,
        stream: true,
      });
      // One model call per round: the reply carries the tool calls and the narration together. The
      // tools run afterwards and their results open the next round's user turn, so no second call
      // re-reads the whole conversation just to say what happened.
      let final: Anthropic.Beta.BetaMessage | undefined;
      for await (const stream of runner) {
        final = await stream.finalMessage();
        break;
      }
      if (!final) throw new Error("game master produced no response");
      const toolResults = await runner.generateToolResponse();
      const used: GmUsage = {
        model: this.model,
        calls: 1,
        inputTokens: final.usage.input_tokens,
        cachedTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
        outputTokens: final.usage.output_tokens,
        players: [...new Set(batch.map((u) => u.playerId))],
      };
      this.onUsage?.(used);
      this.onRound?.({
        utterances: batch.length,
        waitedMs: started - Math.min(...batch.map((u) => u.ts)),
        durationMs: Date.now() - started,
        tools: final.content.filter((b) => b.type === "tool_use").length,
      });
      if (final.stop_reason === "refusal") {
        console.warn("[gm] round refused:", final.stop_details?.category ?? "unknown");
      }
      const text = final.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text.trim())
        .filter(Boolean)
        .join(" ");
      if (text) this.world.narrate(text);

      this.pendingResults = toolResults;
      this.history = trimHistory([...stripCache(messages), { role: "assistant", content: final.content }], this.maxHistory);
      console.log(
        `[gm] round: ${batch.length} utterances, ${Date.now() - started}ms, in ${used.inputTokens} + cached ${used.cachedTokens} + written ${used.cacheWriteTokens}, out ${used.outputTokens}`,
      );
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        console.error(`[gm] API error ${err.status}: ${err.message}`);
        if (err.status === 400) {
          // Almost always a history the model will not accept any more (trimmed thinking blocks,
          // orphaned tool results). Start the conversation over rather than fail every round.
          console.warn("[gm] resetting conversation history");
          this.history = [];
          this.pendingResults = null;
        }
      } else console.error("[gm] round failed:", err);
    } finally {
      this.running = false;
      if (this.pending.length) this.schedule();
    }
  }

  /**
   * History with one cache breakpoint on its last block (the whole prefix, system and tools
   * included, is then read from cache), followed by this round's user turn: last round's tool
   * results, if any, plus the new utterances and snapshot.
   */
  private buildMessages(prompt: string): Msg[] {
    const history = withCacheBreakpoint(this.history);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    const pending = this.pendingResults?.content;
    if (typeof pending === "string") content.push({ type: "text", text: pending });
    else if (Array.isArray(pending)) content.push(...(pending as Block[]));
    content.push({ type: "text", text: prompt });
    return [...history, { role: "user", content }];
  }

  /** Dev-only scripted GM: every utterance summons, then random fights break out. */
  private mockRound(u: Utterance): void {
    const words = u.text.replace(/[^a-z0-9 ]/gi, "").split(/\s+/).filter((w) => w.length > 2);
    const label = (words.slice(-3).join(" ") || "Nameless Thing").slice(0, 40);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
    const size = 1 + Math.random() * 5;
    const e = this.world.summon({
      ownerId: u.playerId,
      label: label.replace(/\b\w/g, (c) => c.toUpperCase()),
      imagePrompt: u.text.slice(0, 200),
      size: Math.round(size * 10) / 10,
      hp: Math.round(40 + size * 40),
      attack: Math.round(5 + size * 8),
      speed: Math.round((1 + Math.random() * 6) * 10) / 10,
      fx: pick(["none", "fire", "sparkles", "lightning", "smoke"] as const),
      idleAnim: pick(["bob", "spin", "pulse", "float"] as const),
      moveStyle: pick(["walk", "hover", "slither", "teleport"] as const),
      placeholderColor: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`,
    });
    this.world.narrate(`${u.name} mutters, and ${e.label} claws its way into the dream.`);
    this.world.awardPoints(u.playerId, 1 + Math.floor(Math.random() * 3), "a summon in the mock dream");
    const others = Object.values(this.world.state.entities).filter((x) => x.ownerId !== u.playerId);
    if (others.length) {
      const target = pick(others);
      const r = this.world.attack(e.id, target.id, Math.round(e.attack * (0.5 + Math.random())), "a lunge out of nowhere");
      if (r?.destroyed) this.world.awardPoints(u.playerId, 4, `destroyed ${target.label}`);
    }
    if (Math.random() < 0.2) {
      const hex = () => `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
      this.world.warp({ skyTop: hex(), skyBottom: hex(), fogColor: hex(), mood: pick(["bruised amber dusk", "glass rain", "sideways noon", "velvet static"]) }, "the sky forgets its color");
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }
}

function effortFromEnv(value: string | undefined, fallback: "low" | "medium" | "high"): "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function formatRound(batch: Utterance[], summary: string): string {
  const lines = batch.map((u) => `- [${u.playerId}] ${u.name}: "${u.text.replace(/\s+/g, " ").trim()}"`);
  return `New things players said since the last round:\n${lines.join("\n")}\n\nCurrent dream:\n${summary}\n\nAct with tools and narrate in this same reply, at most two sentences of plain text.`;
}

type Block = Anthropic.Beta.BetaContentBlockParam;

function blocksOf(m: Msg): Block[] {
  if (typeof m.content === "string") return [{ type: "text", text: m.content }];
  return Array.isArray(m.content) ? [...(m.content as Block[])] : [];
}

/** Drop every cache marker so breakpoints never pile up past the API's limit of four. */
function stripCache(msgs: Msg[]): Msg[] {
  return msgs.map(
    (m) =>
      ({
        role: m.role,
        content: blocksOf(m).map((b) => {
          const { cache_control: _drop, ...rest } = b as Block & { cache_control?: unknown };
          return rest as Block;
        }),
      }) as Msg,
  );
}

/** One ephemeral breakpoint on the last cacheable block of the last message. */
function withCacheBreakpoint(history: Msg[]): Msg[] {
  const msgs = stripCache(history);
  const last = msgs.at(-1);
  if (!last || !Array.isArray(last.content)) return msgs;
  const blocks = last.content as Block[];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === "thinking" || b.type === "redacted_thinking") continue;
    blocks[i] = { ...b, cache_control: { type: "ephemeral" } } as Block;
    break;
  }
  return msgs;
}

/**
 * Keep the tail of the conversation, cutting at a user turn. The first kept user turn may carry tool
 * results for an assistant turn that was dropped, so only its text survives.
 */
function trimHistory(msgs: Msg[], max: number): Msg[] {
  if (msgs.length <= max) return msgs;
  let start = msgs.length - max;
  while (start < msgs.length && msgs[start]!.role !== "user") start++;
  const kept = msgs.slice(start);
  const first = kept[0];
  if (first && first.role === "user") {
    const text = blocksOf(first).filter((b) => b.type === "text");
    kept[0] = { role: "user", content: text.length ? text : [{ type: "text", text: "(earlier rounds omitted)" }] };
  }
  return kept;
}
