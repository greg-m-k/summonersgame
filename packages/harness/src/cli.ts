import "./quiet.ts";
import "./env.ts";
import { type RunOptions, runScenario } from "./scenario.ts";
import { SCENARIOS } from "./scenarios/index.ts";

function usage(): never {
  console.log(`Summoners harness: drive the game with synthetic players and write a report.

usage: npm run harness -- <scenario> [options]

scenarios:
${Object.values(SCENARIOS)
  .map((s) => `  ${s.name.padEnd(10)} ${s.description}`)
  .join("\n")}

options:
  --room <code>     room to use (default: harness-<random>)
  --players <n>     players for explore (default 2)
  --rounds <n>      rounds for explore (default 4)
  --names a,b,c     player names
  --voice           speak real audio through the mic track (Windows TTS); needs STT/TTS keys
  --browser         for the browser scenario: headless Chrome (default); --headed shows it
  --headed          show the browser windows
  --no-assess       skip the Claude critic at the end
  --mock-ok         do not warn when the game master is the mock

Prerequisites: npm run dev (server, agents worker, web) and a LiveKit server.`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const name = argv[0];
if (!name || name === "help" || name === "--help" || name === "list") usage();
const scenario = SCENARIOS[name];
if (!scenario) {
  console.error(`unknown scenario "${name}"`);
  usage();
}

const flag = (k: string): boolean => argv.includes(`--${k}`);
const value = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const opts: RunOptions = {
  room: value("room", `harness-${Math.random().toString(36).slice(2, 7)}`),
  players: Number(value("players", "2")),
  rounds: Number(value("rounds", "4")),
  voice: flag("voice"),
  browser: flag("browser") || name === "browser",
  headed: flag("headed"),
  assess: !flag("no-assess") && (name === "explore" || flag("assess")),
  names: value("names", "").split(",").map((s) => s.trim()).filter(Boolean),
};

const result = await runScenario(scenario, opts);
process.exit(result.ok ? 0 : 1);
