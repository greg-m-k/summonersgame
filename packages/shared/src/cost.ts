import { z } from "zod";

/** LiveKit data-channel topic for cost summaries (server -> everyone, reliable). */
export const TOPIC_COST = "cost";

/** USD per million tokens. */
export interface ClaudePrice {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface PriceTable {
  claude: Record<string, ClaudePrice>;
  /** Used for model ids not in the table. */
  claudeDefault: ClaudePrice;
  /** USD per minute of audio sent to speech-to-text. */
  sttPerMinute: number;
  /** USD per character sent to text-to-speech. */
  ttsPerChar: number;
  /** USD per generated picture. */
  imageEach: number;
}

/**
 * List prices as of 2026-10. Claude prices from the API reference; Deepgram, Cartesia and fal are
 * pay-as-you-go estimates to verify against each vendor's page (override with PRICE_* env vars).
 */
export const DEFAULT_PRICES: PriceTable = {
  claude: {
    "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
    "claude-sonnet-5-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    "claude-haiku-5-5": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  },
  claudeDefault: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  sttPerMinute: 0.0077,
  ttsPerChar: 0.00005,
  imageEach: 0.003,
};

export const SERVICES = ["gm", "demon", "stt", "tts", "image"] as const;
export type Service = (typeof SERVICES)[number];

const base = { playerId: z.string().nullable(), ts: z.number() };

/** One meter reading. Tokens follow the Anthropic split: input excludes cached and cache-write tokens. */
export const UsageEvent = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("llm"),
    service: z.enum(["gm", "demon"]),
    model: z.string(),
    inputTokens: z.number(),
    cachedTokens: z.number(),
    cacheWriteTokens: z.number(),
    outputTokens: z.number(),
    calls: z.number(),
  }),
  z.object({ ...base, kind: z.literal("stt"), seconds: z.number() }),
  z.object({ ...base, kind: z.literal("tts"), chars: z.number() }),
  z.object({ ...base, kind: z.literal("image"), images: z.number() }),
]);
export type UsageEvent = z.infer<typeof UsageEvent>;

/** Agent -> game server, HTTP: batched meter readings from one player's demon. */
export const UsagePost = z.object({
  playerIdentity: z.string(),
  events: z.array(UsageEvent).max(500),
});
export type UsagePost = z.infer<typeof UsagePost>;

export const Units = z.object({
  calls: z.number(),
  inputTokens: z.number(),
  cachedTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  sttSeconds: z.number(),
  ttsChars: z.number(),
  images: z.number(),
});
export type Units = z.infer<typeof Units>;

export const ServiceCost = z.object({ usd: z.number(), units: Units });
export type ServiceCost = z.infer<typeof ServiceCost>;

export const CostSummary = z.object({
  room: z.string(),
  since: z.number(),
  totalUsd: z.number(),
  /** USD per hour over the last five minutes. */
  paceUsdPerHour: z.number(),
  byService: z.record(z.enum(SERVICES), ServiceCost),
  byPlayer: z.record(z.string(), z.object({ usd: z.number(), byService: z.record(z.enum(SERVICES), z.number()) })),
  budgetUsd: z.number().nullable(),
  overBudget: z.boolean(),
});
export type CostSummary = z.infer<typeof CostSummary>;

export const emptyUnits = (): Units => ({
  calls: 0,
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  sttSeconds: 0,
  ttsChars: 0,
  images: 0,
});

export const serviceOf = (ev: UsageEvent): Service => (ev.kind === "llm" ? ev.service : ev.kind);

export function priceUsage(ev: UsageEvent, prices: PriceTable): number {
  switch (ev.kind) {
    case "llm": {
      const p = prices.claude[ev.model] ?? prices.claudeDefault;
      return (ev.inputTokens * p.input + ev.cachedTokens * p.cachedInput + ev.cacheWriteTokens * p.cacheWrite + ev.outputTokens * p.output) / 1e6;
    }
    case "stt":
      return (ev.seconds / 60) * prices.sttPerMinute;
    case "tts":
      return ev.chars * prices.ttsPerChar;
    case "image":
      return ev.images * prices.imageEach;
  }
}

export function addUnits(u: Units, ev: UsageEvent): void {
  switch (ev.kind) {
    case "llm":
      u.calls += ev.calls;
      u.inputTokens += ev.inputTokens;
      u.cachedTokens += ev.cachedTokens;
      u.cacheWriteTokens += ev.cacheWriteTokens;
      u.outputTokens += ev.outputTokens;
      break;
    case "stt":
      u.sttSeconds += ev.seconds;
      break;
    case "tts":
      u.ttsChars += ev.chars;
      break;
    case "image":
      u.images += ev.images;
      break;
  }
}

/** "$0.42 (gm $0.20, demon $0.15, stt $0.01, tts $0.04, image $0.02)" */
export function describeCost(s: CostSummary): string {
  const parts = SERVICES.filter((k) => s.byService[k].usd > 0).map((k) => `${k} $${s.byService[k].usd.toFixed(3)}`);
  return `$${s.totalUsd.toFixed(3)}${parts.length ? ` (${parts.join(", ")})` : ""}, pace $${s.paceUsdPerHour.toFixed(2)}/h`;
}
