import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CostSummary, SERVICES } from "@summoners/shared";
import type { Timeline } from "./timeline.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RunMeta {
  scenario: string;
  room: string;
  startedAt: string;
  gm: string;
  voice: boolean;
  browser: boolean;
  players: string[];
  args: Record<string, unknown>;
}

export interface Assessment {
  verdict: string;
  score: number;
  whatWorked: string[];
  problems: string[];
  bugs: string[];
  suggestions: string[];
  narrative: string;
}

export function writeReport(
  dir: string,
  meta: RunMeta,
  timeline: Timeline,
  checks: Check[],
  assessment: Assessment | null,
  extras: Record<string, unknown> = {},
  cost: CostSummary | null = null,
): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const json = resolve(dir, "run.json");
  const md = resolve(dir, "report.md");
  writeFileSync(json, JSON.stringify({ meta, checks, assessment, cost, extras, timeline: timeline.entries }, null, 2));

  const passed = checks.filter((c) => c.ok).length;
  const lines: string[] = [];
  lines.push(`# Summoners harness run: ${meta.scenario}`);
  lines.push("");
  lines.push(`Room \`${meta.room}\` · started ${meta.startedAt} · game master: ${meta.gm} · voice: ${meta.voice} · browser: ${meta.browser}`);
  lines.push(`Players: ${meta.players.join(", ")}`);
  lines.push("");
  lines.push(`## Checks: ${passed}/${checks.length} passed`);
  lines.push("");
  for (const c of checks) lines.push(`- ${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  lines.push("");
  if (assessment) {
    lines.push(`## Assessment: ${assessment.score}/10 — ${assessment.verdict}`);
    lines.push("");
    lines.push(assessment.narrative);
    lines.push("");
    const section = (title: string, items: string[]) => {
      if (!items.length) return;
      lines.push(`### ${title}`);
      for (const i of items) lines.push(`- ${i}`);
      lines.push("");
    };
    section("What worked", assessment.whatWorked);
    section("Problems", assessment.problems);
    section("Bugs", assessment.bugs);
    section("Suggestions", assessment.suggestions);
  }
  if (cost) {
    lines.push(`## Cost: $${cost.totalUsd.toFixed(3)} (pace $${cost.paceUsdPerHour.toFixed(2)}/h${cost.budgetUsd !== null ? `, budget $${cost.budgetUsd}${cost.overBudget ? " REACHED" : ""}` : ""})`);
    lines.push("");
    lines.push("Estimated at list prices from the meters the server saw (tokens, audio seconds, characters, pictures).");
    lines.push("");
    lines.push("| service | usd | units |");
    lines.push("|---|---|---|");
    for (const k of SERVICES) {
      const s = cost.byService[k];
      const u = s.units;
      const units =
        k === "gm" || k === "demon"
          ? `${u.calls} calls, in ${u.inputTokens} + cached ${u.cachedTokens} + written ${u.cacheWriteTokens}, out ${u.outputTokens}`
          : k === "stt"
            ? `${u.sttSeconds.toFixed(1)} s of audio`
            : k === "tts"
              ? `${u.ttsChars} chars`
              : `${u.images} pictures`;
      lines.push(`| ${k} | $${s.usd.toFixed(4)} | ${units} |`);
    }
    lines.push("");
    const players = Object.entries(cost.byPlayer).sort((a, b) => b[1].usd - a[1].usd);
    if (players.length) {
      lines.push("| player | usd | gm | demon | stt | tts | image |");
      lines.push("|---|---|---|---|---|---|---|");
      for (const [id, p] of players) {
        lines.push(`| ${id} | $${p.usd.toFixed(4)} | ${SERVICES.map((k) => `$${p.byService[k].toFixed(4)}`).join(" | ")} |`);
      }
      lines.push("");
    }
  }
  for (const [k, v] of Object.entries(extras)) {
    lines.push(`## ${k}`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(v, null, 2));
    lines.push("```");
    lines.push("");
  }
  lines.push("## Timeline");
  lines.push("");
  lines.push("| t | kind | actor | what |");
  lines.push("|---|---|---|---|");
  for (const e of timeline.entries) {
    lines.push(`| ${(e.t / 1000).toFixed(1)}s | ${e.kind} | ${e.actor ?? ""} | ${e.text.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  }
  writeFileSync(md, lines.join("\n"));
  return { json, md };
}
