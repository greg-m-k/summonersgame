import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "./env.ts";
import type { Assessment } from "./report.ts";
import type { Timeline } from "./timeline.ts";

const MODEL = "claude-opus-5-5";

export const PERSONALITIES = [
  "an aggressive min-maxer who wants kills and says so",
  "a surreal poet who describes impossible things in sensory detail",
  "a cautious builder who makes defensive things and complains about fairness",
  "a troll who tries to break the game with meta jokes and nonsense",
  "a cooperative kid who wants everyone's creatures to be friends",
  "a dramatic villain who monologues",
];

const Decision = z.object({
  utterance: z.string().min(1).max(200),
  holdMic: z.boolean(),
  micLine: z.string().max(160).optional(),
  reasoning: z.string().max(200),
});
export type Decision = z.infer<typeof Decision>;

const AssessmentSchema = z.object({
  verdict: z.string().max(120),
  score: z.number().int().min(1).max(10),
  whatWorked: z.array(z.string().max(200)).max(8),
  problems: z.array(z.string().max(200)).max(8),
  bugs: z.array(z.string().max(200)).max(8),
  suggestions: z.array(z.string().max(200)).max(8),
  narrative: z.string().max(2000),
});

/** Claude-driven player and critic. Without an API key both fall back to scripted behaviour. */
export class Brain {
  private client: Anthropic | null;
  constructor() {
    this.client = env.ANTHROPIC_API_KEY ? new Anthropic() : null;
    if (!this.client) console.warn("[brain] no ANTHROPIC_API_KEY: players use scripted lines and the critic is statistical");
  }

  get live(): boolean {
    return this.client !== null;
  }

  private async json<T>(schema: z.ZodType<T>, system: string, user: string, effort: "low" | "medium" | "high"): Promise<T> {
    if (!this.client) throw new Error("no client");
    const res = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema: z.toJSONSchema(schema) as Record<string, unknown> } },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    if (res.stop_reason === "refusal") throw new Error(`refused: ${res.stop_details?.category ?? "?"}`);
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return schema.parse(JSON.parse(text));
  }

  /** What does this player say next? */
  async decide(player: { name: string; personality: string; micBank: number; score: number }, timeline: Timeline, round: number): Promise<Decision> {
    if (!this.client) return scriptedDecision(player, round);
    const system = `You are playtesting SUMMONERS, a voice game. You play "${player.name}", ${player.personality}. You talk out loud to your personal demon; anything you describe appears in a shared dream arena a few seconds later and may fight other players' things. Points buy seconds on the room microphone where other humans can hear you (your demon cannot).

Each round you get the recent event log. Reply with ONE sentence you say to your demon next (under 25 words, natural speech, no quotes). Vary what you do: summon, order an attack on a specific enemy thing by name, transform your own thing, change the weather or gravity, taunt. Set holdMic true only when you have at least 5 seconds banked and have something worth saying to the humans; then put that sentence in micLine. Stay in character.`;
    const user = `Round ${round}. You have ${player.score} points and ${Math.round(player.micBank)}s of mic time.\n\nRecent events:\n${timeline.recent(40, ["say", "summon", "attack", "destroy", "transform", "warp", "narrate", "points", "demon-said", "mic", "player"]) || "(nothing yet)"}`;
    try {
      return await this.json(Decision, system, user, "low");
    } catch (err) {
      console.warn("[brain] decide failed, using script:", err instanceof Error ? err.message : err);
      return scriptedDecision(player, round);
    }
  }

  /** After the run: did the game make sense? */
  async assess(
    meta: { scenario: string; gm: string; voice: boolean; cost?: string },
    timeline: Timeline,
    checks: { name: string; ok: boolean; detail?: string }[],
  ): Promise<Assessment> {
    if (!this.client) return statisticalAssessment(timeline, checks);
    const system = `You are a game designer reviewing an automated playtest log of SUMMONERS: players speak to personal AI demons, a game master AI turns their words into creatures, attacks, transformations, and world changes in a shared arena, and awards points that buy room-microphone time. Judge from the log only. Be concrete: cite timestamps and quotes. Call out mismatches between what a player said and what the game master manifested, slow reactions, unfair or missing points, demon lines that ignore the situation, repetitive narration, and anything that looks like a bug (events out of order, entities that never appear, errors). Score 1-10 for "would a group of friends enjoy this for twenty minutes".`;
    const user = `Scenario: ${meta.scenario}. Game master: ${meta.gm}${meta.gm === "mock" ? " (scripted stand-in, judge pipeline and pacing, not creativity)" : ""}. Voice pipeline: ${meta.voice}. Estimated cost of this run: ${meta.cost ?? "unknown"} (weigh fun against spend; say whether the points and moments earned were worth the money).\n\nAutomated checks:\n${checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("\n")}\n\nFull log:\n${timeline.recent(400, undefined)}`;
    try {
      return await this.json(AssessmentSchema, system, user, "medium");
    } catch (err) {
      console.warn("[brain] assess failed, using statistics:", err instanceof Error ? err.message : err);
      return statisticalAssessment(timeline, checks);
    }
  }
}

const SCRIPT = [
  "summon a {adj} {noun} that breathes {element}",
  "make my {noun} twice as big and give it {element} wings",
  "my {noun} attacks the nearest enemy thing right now",
  "turn the sky {color} and make gravity go sideways",
  "I want a swarm of tiny {adj} {noun}s",
  "unleash a {adj} {noun} the size of a house",
];
const WORDS: Record<string, string[]> = {
  adj: ["flaming", "glass", "rusted", "screaming", "velvet", "static", "frozen", "neon"],
  noun: ["whale", "wolf", "teapot", "robot bee", "cathedral", "moth", "piano", "octopus"],
  element: ["lightning", "smoke", "sparkles", "fire", "ink"],
  color: ["blood red", "sickly green", "pure white", "bruised purple"],
};

function scriptedDecision(player: { micBank: number }, round: number): Decision {
  const pick = (k: string) => WORDS[k]![(round * 7 + k.length) % WORDS[k]!.length]!;
  const template = SCRIPT[round % SCRIPT.length]!;
  const utterance = template.replace(/\{(\w+)\}/g, (_, k: string) => pick(k));
  const holdMic = player.micBank >= 5 && round % 3 === 2;
  return { utterance, holdMic, micLine: holdMic ? "hey humans, my thing is winning" : undefined, reasoning: "scripted" };
}

function statisticalAssessment(timeline: Timeline, checks: { name: string; ok: boolean }[]): Assessment {
  const count = (k: string) => timeline.entries.filter((e) => e.kind === k).length;
  const says = timeline.entries.filter((e) => e.kind === "say");
  const summons = timeline.entries.filter((e) => e.kind === "summon");
  const latencies = says.map((s) => {
    const next = summons.find((m) => m.t > s.t && m.t - s.t < 30_000);
    return next ? next.t - s.t : null;
  }).filter((n): n is number => n !== null);
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const failed = checks.filter((c) => !c.ok).length;
  return {
    verdict: failed ? `${failed} check(s) failed` : "pipeline healthy",
    score: Math.max(1, Math.min(10, 7 - failed)),
    whatWorked: [`${count("summon")} summons, ${count("attack")} attacks, ${count("destroy")} kills, ${count("warp")} warps, ${count("points")} point awards`],
    problems: avg === null ? ["no utterance produced a summon"] : [`mean utterance-to-summon latency ${avg} ms`],
    bugs: timeline.entries.filter((e) => e.kind === "subscribe-failed" || e.kind === "disconnect").map((e) => e.text),
    suggestions: ["set ANTHROPIC_API_KEY to get a real design review"],
    narrative: `Statistical summary only (no Claude). ${says.length} utterances, ${count("demon-said")} demon lines, ${count("mic")} mic-time events.`,
  };
}
