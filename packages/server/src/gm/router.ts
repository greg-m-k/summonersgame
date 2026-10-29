import Anthropic from "@anthropic-ai/sdk";
import { TALENTS } from "@summoners/shared";
import { z } from "zod";

/**
 * The cheap first reader. Every line a player says passes through Haiku before anything expensive
 * happens: chatter and questions to the demon stop here, talent picks are applied directly, and
 * only lines that change the dream go on to the Opus game master. Fast (under a second), a
 * thousandth of a cent, and it stops "test, test" from costing a round.
 */

export const Intent = z.object({
  kind: z.enum(["summon", "transform", "attack", "warp", "talent", "chatter"]).describe(
    "summon: wants something new to exist. transform: changes an existing thing. attack: orders a strike. warp: changes sky, weather, gravity, mood. talent: asks to take or spend a talent. chatter: talking to the demon, questions, filler, tests, or nothing actionable.",
  ),
  talentId: z
    .enum(TALENTS.map((t) => t.id) as [string, ...string[]])
    .nullable()
    .describe("the talent being chosen, only for kind talent"),
  gist: z.string().max(80).describe("the actionable part in a few words, or empty"),
});
export type Intent = z.infer<typeof Intent>;

export interface RouterUsage {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

const SYSTEM = `You read one line a player just said inside SUMMONERS, a game where whatever players describe appears in a shared dream and fights. Classify the line. Rules: anything that describes a creature, object, place, or phenomenon the player wants is a summon, even phrased casually ("I want", "give me", "what about a"). Changing something that exists ("make it bigger", "give my whale wings") is a transform. Telling a creature to hit something is an attack. Weather, light, gravity, mood, or scenery is a warp. Asking for, choosing, or spending a talent (Sharp Teeth, Bloodlust, Overkill, Thick Hide, Regrowth, Second Wind, Silver Tongue, Echo, Haste) is a talent pick. Greetings, questions, commentary, mic tests, "um", and talk aimed at the demon are chatter. When in doubt between chatter and summon, a concrete noun phrase wins: summon.`;

export class IntentRouter {
  private client = new Anthropic();

  constructor(
    private model = process.env.ROUTER_MODEL ?? "claude-haiku-5-5",
    private onUsage?: (u: RouterUsage) => void,
  ) {}

  async classify(text: string): Promise<{ intent: Intent; usage: RouterUsage | null }> {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 200,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: z.toJSONSchema(Intent) as Record<string, unknown> } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: text }],
    });
    const usage: RouterUsage = {
      model: this.model,
      inputTokens: res.usage.input_tokens,
      cachedTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      outputTokens: res.usage.output_tokens,
    };
    this.onUsage?.(usage);
    const block = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
    const parsed = Intent.safeParse(JSON.parse(block?.text ?? "{}"));
    return { intent: parsed.success ? parsed.data : { kind: "summon", talentId: null, gist: text.slice(0, 80) }, usage };
  }
}

/** Keyless stand-in: a handful of patterns, generous toward summon like the real one. */
export function mockClassify(text: string): Intent {
  const t = text.toLowerCase();
  const talent = TALENTS.find((x) => t.includes(x.name.toLowerCase()) || t.includes(x.id.replace("_", " ")));
  if (talent && /take|spend|pick|choose|want|give me/.test(t)) return { kind: "talent", talentId: talent.id, gist: talent.name };
  if (/\b(attacks?|hits?|eats?|smash(es)?|strikes?|kills?|bites?)\b/.test(t)) return { kind: "attack", talentId: null, gist: text.slice(0, 80) };
  if (/\b(sky|rain|gravity|fog|night|storm|upside down|dark)\b/.test(t)) return { kind: "warp", talentId: null, gist: text.slice(0, 80) };
  if (/\b(bigger|smaller|wings|turn it|make it|give it)\b/.test(t)) return { kind: "transform", talentId: null, gist: text.slice(0, 80) };
  if (/^(hi|hey|hello|test|testing|um+|uh+|ok|okay|what|why|how|who|where)\b/.test(t) || t.split(/\s+/).length < 3) return { kind: "chatter", talentId: null, gist: "" };
  return { kind: "summon", talentId: null, gist: text.slice(0, 80) };
}
