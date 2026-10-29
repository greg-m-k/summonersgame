import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeCost } from "@summoners/shared";
import { api } from "./api.ts";
import { Bot, sleep } from "./bot.ts";
import { Brain } from "./brain.ts";
import { type Check, type RunMeta, writeReport } from "./report.ts";
import { Timeline } from "./timeline.ts";

export interface RunOptions {
  room: string;
  players: number;
  rounds: number;
  voice: boolean;
  browser: boolean;
  headed: boolean;
  assess: boolean;
  names: string[];
}

export interface Ctx {
  opts: RunOptions;
  gm: "mock" | "claude";
  timeline: Timeline;
  bots: Bot[];
  brain: Brain;
  runDir: string;
  /** How long to wait for the game master to react to speech. */
  gmTimeout: number;
  check(name: string, ok: boolean, detail?: string): boolean;
  spawn(name: string, voiceIndex?: number): Promise<Bot>;
  sleep(ms: number): Promise<void>;
}

export interface Scenario {
  name: string;
  description: string;
  run(ctx: Ctx): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<{ ok: boolean; reportPath: string }> {
  const health = await api.health().catch((err) => {
    throw new Error(`game server not reachable at ${process.env.GAME_SERVER_URL ?? "http://localhost:8787"}: ${err instanceof Error ? err.message : err}. Start it with npm run dev.`);
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(here, "../runs", `${stamp}-${scenario.name}`);
  mkdirSync(runDir, { recursive: true });
  const timeline = new Timeline();
  const checks: Check[] = [];
  const bots: Bot[] = [];
  const brain = new Brain();

  const ctx: Ctx = {
    opts,
    gm: health.gm,
    timeline,
    bots,
    brain,
    runDir,
    gmTimeout: health.gm === "claude" ? 25_000 : 5_000,
    check(name, ok, detail) {
      checks.push({ name, ok, detail });
      timeline.add("check", `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
      return ok;
    },
    async spawn(name, voiceIndex = bots.length) {
      const bot = new Bot({ room: opts.room, name, timeline, voice: opts.voice, voiceIndex, recordDir: runDir, reporter: bots.length === 0 });
      bots.push(bot);
      await bot.join();
      return bot;
    },
    sleep,
  };

  timeline.add("run", `scenario "${scenario.name}" in room ${opts.room}: ${scenario.description}`);
  timeline.add(
    "run",
    `game master ${health.gm}, images ${health.images}, demons stt=${health.demon.stt} llm=${health.demon.llm} tts=${health.demon.tts}, voice ${opts.voice}, browser ${opts.browser}`,
  );
  let fatal: string | null = null;
  try {
    await scenario.run(ctx);
  } catch (err) {
    fatal = err instanceof Error ? (err.stack ?? err.message) : String(err);
    timeline.add("error", fatal);
    ctx.check("scenario completed without exceptions", false, (err instanceof Error ? err.message : String(err)).slice(0, 200));
  }

  const extras: Record<string, unknown> = {};
  for (const bot of bots) {
    const r = await bot.leave().catch(() => ({ demonAudioSeconds: 0 }));
    extras[`player ${bot.name}`] = {
      identity: bot.identity,
      persona: bot.session?.persona,
      demon: bot.demonIdentity,
      demonAudioSeconds: Math.round(r.demonAudioSeconds * 10) / 10,
      demonLines: bot.demonSaid,
      demonHeardMe: bot.demonHeard,
      score: bot.me?.score ?? 0,
      micBank: bot.me?.micBank ?? 0,
      entities: bot.myEntities().map((e) => `${e.label} (hp ${e.hp}/${e.maxHp})`),
    };
  }

  const cost = await api.cost(opts.room).catch(() => null);
  const costLine = cost ? describeCost(cost) : "unknown";
  const assessment = opts.assess
    ? await brain.assess({ scenario: scenario.name, gm: health.gm, voice: opts.voice, cost: costLine }, timeline, checks)
    : null;
  const meta: RunMeta = {
    scenario: scenario.name,
    room: opts.room,
    startedAt: new Date(timeline.startedAt).toISOString(),
    gm: health.gm,
    voice: opts.voice,
    browser: opts.browser,
    players: bots.map((b) => b.name),
    args: { ...opts },
  };
  const { md } = writeReport(runDir, meta, timeline, checks, assessment, extras, cost);
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n=== ${scenario.name}: ${passed}/${checks.length} checks passed${fatal ? " (with exception)" : ""} ===`);
  console.log(`=== cost ${costLine} ===`);
  if (assessment) console.log(`=== assessment ${assessment.score}/10: ${assessment.verdict} ===`);
  console.log(`report: ${md}`);
  return { ok: passed === checks.length && !fatal, reportPath: md };
}
