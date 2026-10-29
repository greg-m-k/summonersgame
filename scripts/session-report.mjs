// Read a past session out of the D1 log and write a report you can learn from.
//   node scripts/session-report.mjs                 # list recent sessions
//   node scripts/session-report.mjs static-925      # write reports/static-925.md
// Needs GAME_SERVER_SECRET (from .env) and PUBLIC_URL (default https://games.greg.kitchen/summoners).
import { mkdirSync, writeFileSync } from "node:fs";

process.loadEnvFile(new URL("../.env", import.meta.url));
const BASE = process.env.PUBLIC_URL ?? "https://games.greg.kitchen/summoners";
const headers = { "x-game-secret": process.env.GAME_SERVER_SECRET ?? "" };
const room = process.argv[2];

const t = (ms, start) => `${((ms - start) / 1000).toFixed(1)}s`;
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

if (!room) {
  const sessions = await (await fetch(`${BASE}/_ops/sessions`, { headers })).json();
  console.log("room           started (UTC)        minutes  events  utterances");
  for (const s of sessions) {
    console.log(`${s.room.padEnd(15)}${new Date(s.startedAt).toISOString().slice(0, 16).padEnd(21)}${(((s.endedAt - s.startedAt) / 60000).toFixed(1)).padStart(7)}${String(s.events).padStart(8)}${String(s.utterances).padStart(12)}`);
  }
  process.exit(0);
}

const events = await (await fetch(`${BASE}/_ops/rooms/${encodeURIComponent(room)}/log`, { headers })).json();
if (!events.length) {
  console.error(`no log for room ${room}`);
  process.exit(1);
}
const start = events[0].ts;
const end = events.at(-1).ts;
const players = new Map();
const name = (id) => players.get(id)?.name ?? id;
const entities = new Map();
const label = (id) => entities.get(id)?.label ?? id;
const summons = [];
const kills = [];
const matches = [];
const demonErrors = [];
const lines = [];
let lastCost = null;
const utteranceRows = [];
const rounds = [];
const metrics = [];
const demonSaid = [];
const worldEvents = [];

for (const e of events) {
  const d = e.data;
  switch (e.kind) {
    case "event": {
      const ev = d;
      worldEvents.push({ ts: e.ts, ev });
      if (ev.type === "player_joined" || ev.type === "player_updated") players.set(ev.player.identity, ev.player);
      if (ev.type === "summon") {
        entities.set(ev.entity.id, ev.entity);
        summons.push({ ts: e.ts, by: name(ev.entity.ownerId), label: ev.entity.label, hp: ev.entity.hp, atk: ev.entity.attack, size: ev.entity.size });
        lines.push([e.ts, "summon", `${name(ev.entity.ownerId)} summons ${ev.entity.label} (hp ${ev.entity.hp}, atk ${ev.entity.attack}, size ${ev.entity.size})`]);
      }
      if (ev.type === "transform") entities.set(ev.entity.id, ev.entity);
      if (ev.type === "match_started") for (const h of ev.hearts) entities.set(h.id, h);
      if (ev.type === "destroy") {
        kills.push({ ts: e.ts, what: label(ev.entityId), cause: ev.cause });
        lines.push([e.ts, "destroy", `${label(ev.entityId)}: ${ev.cause}`]);
      }
      if (ev.type === "attack" && !ev.auto) lines.push([e.ts, "strike", `${label(ev.attackerId)} hits ${label(ev.targetId)} for ${ev.damage}: ${ev.flavor}`]);
      if (ev.type === "narrate") lines.push([e.ts, "narrate", ev.text]);
      if (ev.type === "points") lines.push([e.ts, "points", `+${ev.points} ${name(ev.playerId)}: ${ev.reason}`]);
      if (ev.type === "level_up") lines.push([e.ts, "level", `${name(ev.playerId)} reaches level ${ev.level}`]);
      if (ev.type === "talent") lines.push([e.ts, "talent", `${name(ev.playerId)} takes ${ev.talentId}`]);
      if (ev.type === "warp_world") lines.push([e.ts, "warp", ev.description]);
      if (ev.type === "mic_time" && ev.on) lines.push([e.ts, "mic", `${name(ev.playerId)} on the room mic (${ev.micBank}s)`]);
      if (ev.type === "match_started") lines.push([e.ts, "match", `match ${ev.match.number} begins`]);
      if (ev.type === "match_over") {
        matches.push({ ts: e.ts, number: ev.match.number, winner: ev.winner, scores: ev.scores, bribes: ev.bribes });
        lines.push([e.ts, "match", `match ${ev.match.number} over: ${ev.winner ?? "nobody"} wins; bribes ${JSON.stringify(ev.bribes)}`]);
      }
      break;
    }
    case "utterance":
      utteranceRows.push({ ts: e.ts, playerId: d.playerId, name: d.name, text: d.text });
      lines.push([e.ts, "said", `${d.name}: "${d.text}"`]);
      break;
    case "intent":
      lines.push([e.ts, "router", `${d.name}: ${d.kind}${d.talentId ? ` ${d.talentId}` : ""}${d.gist ? ` (${d.gist})` : ""}`]);
      break;
    case "gm_round":
      rounds.push({ ts: e.ts, ...d });
      lines.push([e.ts, "gm", `round: ${d.utterances} lines, waited ${d.waitedMs} ms, Claude ${d.durationMs} ms, ${d.tools} tool calls`]);
      break;
    case "metric":
      metrics.push({ ts: e.ts, ...d });
      break;
    case "demon_said":
      demonSaid.push({ ts: e.ts, playerId: d.playerId });
      lines.push([e.ts, "demon", `${d.persona} to ${d.name}: "${d.text}"`]);
      break;
    case "demon_online":
      lines.push([e.ts, "demon", `${d.persona} manifests for ${d.name}${d.mocks?.length ? ` (mocks ${d.mocks.join(",")})` : ""}`]);
      break;
    case "demon_error":
      demonErrors.push({ ts: e.ts, who: `${d.persona} for ${d.name}`, detail: d.detail });
      lines.push([e.ts, "demon-error", `${d.persona} for ${d.name}: ${d.detail}`]);
      break;
    case "secret":
      lines.push([e.ts, "bribe", `${name(d.playerId)}: ${d.type === "temptation" ? `offered "${d.text}" (+${d.rewardSeconds}s)` : `${d.success ? "took" : "lost"} "${d.text}"`}`]);
      break;
    case "cost":
      lastCost = d;
      break;
    case "room_created":
    case "room_disposed":
      lines.push([e.ts, "room", e.kind === "room_created" ? "room created" : `room disposed (total $${(d.totalUsd ?? 0).toFixed(3)})`]);
      break;
  }
}

const utterances = events.filter((e) => e.kind === "utterance").length;
const demonLines = events.filter((e) => e.kind === "demon_said").length;
const autoHits = events.filter((e) => e.kind === "event" && e.data.type === "attack" && e.data.auto).length;
const md = [];
md.push(`# Session ${room}`);
md.push("");
md.push(`${new Date(start).toISOString()} to ${clock(end)} UTC · ${((end - start) / 60000).toFixed(1)} min · ${events.length} log rows`);
md.push("");
md.push("## Players");
md.push("");
for (const p of players.values()) md.push(`- ${p.name} (${p.identity}), team ${p.team}, ${p.persona}, level ${p.level}, score ${p.score}`);
md.push("");
md.push("## Numbers");
md.push("");
md.push(`- ${utterances} things said to demons, ${demonLines} demon lines, ${summons.length} summons, ${kills.length} deaths, ${autoHits} engine swings, ${matches.length} matches finished`);
if (lastCost) md.push(`- cost at last snapshot: $${lastCost.totalUsd.toFixed(3)} (${Object.entries(lastCost.byService).map(([k, v]) => `${k} $${v.usd.toFixed(3)}`).join(", ")})`);
if (demonErrors.length) {
  md.push(`- ${demonErrors.length} demon failures:`);
  for (const d of demonErrors) md.push(`  - ${clock(d.ts)} ${d.who}: ${d.detail}`);
}
md.push("");
if (matches.length) {
  md.push("## Matches");
  md.push("");
  for (const m of matches) md.push(`- ${clock(m.ts)} match ${m.number}: ${m.winner ?? "nobody"} wins; scores ${JSON.stringify(m.scores)}; bribes ${JSON.stringify(m.bribes)}`);
  md.push("");
}
// ---- latency: what each utterance cost the player in waiting ----------------------------------
const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const fmt = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`);
const chains = utteranceRows.map((u) => {
  const round = rounds.find((r) => r.ts > u.ts);
  const reaction = worldEvents.find((w) => w.ts > u.ts && (w.ev.type === "summon" || w.ev.type === "transform" || w.ev.type === "warp_world" || (w.ev.type === "attack" && !w.ev.auto) || w.ev.type === "destroy") );
  const reply = demonSaid.find((d) => d.ts > u.ts && d.playerId === u.playerId);
  return { u, gmMs: round ? round.ts - u.ts : null, gmThink: round?.durationMs ?? null, worldMs: reaction ? reaction.ts - u.ts : null, demonMs: reply ? reply.ts - u.ts : null };
});
const llm = metrics.filter((m) => m.stage === "llm" && !m.cancelled && m.ttftMs > 0).map((m) => m.ttftMs);
const tts = metrics.filter((m) => m.stage === "tts" && m.ttfbMs > 0).map((m) => m.ttfbMs);
const ears = metrics.filter((m) => m.stage === "ears").map((m) => m.endOfUtteranceDelayMs + m.transcriptionDelayMs);
md.push("## Latency: what the player waited for");
md.push("");
md.push("Per stage, median and 90th percentile: ears is Deepgram end-of-turn plus final transcript; brain is Claude first token in the demon; voice is Cartesia first audio; game master is one Claude round.");
md.push("");
md.push("| stage | samples | median | p90 |");
md.push("|---|---|---|---|");
md.push(`| ears (Deepgram) | ${ears.length} | ${fmt(pct(ears, 0.5))} | ${fmt(pct(ears, 0.9))} |`);
md.push(`| brain (demon Claude first token) | ${llm.length} | ${fmt(pct(llm, 0.5))} | ${fmt(pct(llm, 0.9))} |`);
md.push(`| voice (Cartesia first audio) | ${tts.length} | ${fmt(pct(tts, 0.5))} | ${fmt(pct(tts, 0.9))} |`);
md.push(`| game master round (Claude) | ${rounds.length} | ${fmt(pct(rounds.map((r) => r.durationMs), 0.5))} | ${fmt(pct(rounds.map((r) => r.durationMs), 0.9))} |`);
md.push(`| game master batching wait | ${rounds.length} | ${fmt(pct(rounds.map((r) => r.waitedMs), 0.5))} | ${fmt(pct(rounds.map((r) => r.waitedMs), 0.9))} |`);
md.push("");
md.push("Per utterance, from the moment the transcript reached the server: until the game master round finished, until something changed in the world, until the demon finished its reply.");
md.push("");
md.push("| t | who said | game master done | world changed | demon replied |");
md.push("|---|---|---|---|---|");
for (const c of chains) md.push(`| ${t(c.u.ts, start)} | ${c.u.name}: ${c.u.text.slice(0, 50).replace(/\|/g, "/")} | ${fmt(c.gmMs)} | ${fmt(c.worldMs)} | ${fmt(c.demonMs)} |`);
md.push("");
md.push("## Summons");
md.push("");
md.push("| t | by | what | hp | atk | size |");
md.push("|---|---|---|---|---|---|");
for (const s of summons) md.push(`| ${t(s.ts, start)} | ${s.by} | ${s.label} | ${s.hp} | ${s.atk} | ${s.size} |`);
md.push("");
md.push("## Timeline");
md.push("");
md.push("| t | kind | what |");
md.push("|---|---|---|");
for (const [ts, kind, text] of lines) md.push(`| ${t(ts, start)} | ${kind} | ${String(text).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
const out = new URL(`../reports/${room}.md`, import.meta.url);
writeFileSync(out, md.join("\n"));
console.log(`wrote reports/${room}.md (${lines.length} timeline lines)`);
