// Emits the JSON `wrangler secret bulk` expects, from either the process environment (CI, with
// `--from-env`) or the repo's .env (local, default). Values go straight to stdout for piping;
// nothing is logged.
import { readFileSync } from "node:fs";

const NAMES = [
  "ANTHROPIC_API_KEY",
  "DEEPGRAM_API_KEY",
  "CARTESIA_API_KEY",
  "FAL_API_KEY",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "GAME_SERVER_SECRET",
];

const fromEnv = process.argv.includes("--from-env");
const source = {};
if (fromEnv) {
  for (const n of NAMES) if (process.env[n]) source[n] = process.env[n];
} else {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, v] = m;
    if (k === "FAL_KEY" && v) source.FAL_API_KEY = v;
    if (NAMES.includes(k) && v) source[k] = v;
  }
}
const missing = NAMES.filter((n) => !source[n]);
if (missing.length) console.error(`[secrets] not set (skipped): ${missing.join(", ")}`);
process.stdout.write(JSON.stringify(source));
