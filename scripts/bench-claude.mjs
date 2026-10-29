// Standalone copy of packages/server/src/bench/claude.ts for machines without the repo (Node 20+).
// Reads ANTHROPIC_API_KEY from the environment or from a .env next to the repo root; prints one line per run.
//   node scripts/bench-claude.mjs [model] [runs]
import { existsSync } from "node:fs";

const envFile = new URL("../.env", import.meta.url);
if (!process.env.ANTHROPIC_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("ANTHROPIC_API_KEY not set");
const model = process.argv[2] || "claude-sonnet-5-5";
const runs = Number(process.argv[3]) || 3;

const SYSTEM = "You are Skreel, a demon bound to one human player, Ada, inside SUMMONERS: a shared dream where several players each talk to their own demon, and whatever they say to you leaks into the dream and becomes real. You are speaking out loud through a voice in a loud room; keep every reply to ONE short sentence, under twenty words, no lists, no stage directions, no emoji. Your personality: a paranoid conspiracy demon convinced the other players are cheating. Two teams, Ash and Tide, each with a heart on its side of the arena. Ada is on team Ash. Everything they summon marches toward the enemy heart on its own and fights what it meets. Points come from vivid summons, kills, heart damage, and winning. Points buy seconds on the room microphone. You are on nobody's side. Other players' demons are your rivals. If the player is quiet, say something short to provoke them, then stop. Right now: match 1 is live, hearts Ash 1200, Tide 1200. Ada is level 1 with 0 points, 0 talent points, no talents, 0 seconds of mic time.";

for (const variant of ["adaptive", "between_tools"]) {
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    let ttft = -1;
    let tokens = 0;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          stream: true,
          system: SYSTEM,
          output_config: { effort: "low" },
          ...(variant === "between_tools" ? { thinking: { type: "between_tools" } } : {}),
          messages: [{ role: "user", content: "Summon a glass spider the size of a house." }],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ttft < 0) ttft = performance.now() - started;
          if (ev.type === "message_delta" && ev.usage?.output_tokens) tokens = ev.usage.output_tokens;
        }
      }
      console.log(`${variant.padEnd(14)} ttft ${String(Math.round(ttft)).padStart(5)} ms  total ${String(Math.round(performance.now() - started)).padStart(5)} ms  ${tokens} tokens`);
    } catch (err) {
      console.log(`${variant.padEnd(14)} error ${err.message}`);
    }
  }
}
