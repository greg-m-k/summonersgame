import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PRICES, type PriceTable } from "@summoners/shared";

for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(p)) {
    process.loadEnvFile(p);
    break;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

export const env = {
  PORT: Number(process.env.PORT ?? 8787),
  LIVEKIT_URL: required("LIVEKIT_URL"),
  LIVEKIT_API_KEY: required("LIVEKIT_API_KEY"),
  LIVEKIT_API_SECRET: required("LIVEKIT_API_SECRET"),
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  /** fal.ai credentials; FAL_API_KEY accepted as an alias. */
  FAL_KEY: process.env.FAL_KEY || process.env.FAL_API_KEY || "",
  GAME_SERVER_SECRET: process.env.GAME_SERVER_SECRET ?? "change-me",
  GAME_SERVER_URL: process.env.GAME_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /** Where room logs go (the Worker's /_ops/log); unset means packages/server/logs/<room>.jsonl. */
  LOG_SINK_URL: process.env.LOG_SINK_URL || undefined,
  /** Agents dispatch name; must match ServerOptions.agentName in packages/agents. */
  DEMON_AGENT_NAME: process.env.DEMON_AGENT_NAME ?? "demon",
  /** Hit points of each team's heart (default in packages/shared); small values make short matches for testing. */
  HEART_HP: Number(process.env.HEART_HP) || undefined,
  /** Pause the game master and every demon once a room's estimated spend reaches this many dollars. */
  ROOM_BUDGET_USD: process.env.ROOM_BUDGET_USD ? Number(process.env.ROOM_BUDGET_USD) : null,
};

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return process.env[name] && Number.isFinite(v) ? v : fallback;
};

/** List prices with per-vendor overrides from PRICE_STT_PER_MIN, PRICE_TTS_PER_CHAR, PRICE_IMAGE_EACH. */
export const prices: PriceTable = {
  ...DEFAULT_PRICES,
  sttPerMinute: num("PRICE_STT_PER_MIN", DEFAULT_PRICES.sttPerMinute),
  ttsPerChar: num("PRICE_TTS_PER_CHAR", DEFAULT_PRICES.ttsPerChar),
  imageEach: num("PRICE_IMAGE_EACH", DEFAULT_PRICES.imageEach),
};

/** LiveKit server API URL: LIVEKIT_URL with ws(s) swapped for http(s). */
export const livekitHttpUrl = env.LIVEKIT_URL.replace(/^ws/, "http");
