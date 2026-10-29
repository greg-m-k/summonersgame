/**
 * Time to first token for a demon-shaped request, raw fetch so the same code runs in the server
 * container, on a VPS, or on a laptop. Variants: thinking adaptive (model default at low effort) and
 * thinking off (`between_tools`), which is what the demons use on Sonnet.
 */
export interface BenchResult {
  variant: string;
  model: string;
  ttftMs: number;
  totalMs: number;
  outputTokens: number;
  error?: string;
}

const SYSTEM = `You are Skreel, a demon bound to one human player, Ada, inside SUMMONERS: a shared dream where several players each talk to their own demon, and whatever they say to you leaks into the dream and becomes real. You are speaking out loud through a voice in a loud room; keep every reply to ONE short sentence, under twenty words, no lists, no stage directions, no emoji. Your personality: a paranoid conspiracy demon convinced the other players are cheating. Two teams, Ash and Tide, each with a heart on its side of the arena. Ada is on team Ash. Everything they summon marches toward the enemy heart on its own and fights what it meets. Points come from vivid summons, kills, heart damage, and winning. Points buy seconds on the room microphone. You are on nobody's side. Other players' demons are your rivals. If the player is quiet, say something short to provoke them, then stop. Right now: match 1 is live, hearts Ash 1200, Tide 1200. Ada is level 1 with 0 points, 0 talent points, no talents, 0 seconds of mic time.`;

export async function benchClaude(
  apiKey: string,
  opts: { model?: string; variants?: Array<"adaptive" | "between_tools">; runs?: number } = {},
): Promise<BenchResult[]> {
  const model = opts.model ?? "claude-sonnet-5-5";
  const variants = opts.variants ?? ["adaptive", "between_tools"];
  const runs = opts.runs ?? 3;
  const out: BenchResult[] = [];
  for (const variant of variants) {
    for (let i = 0; i < runs; i++) {
      const started = performance.now();
      let ttft = -1;
      let outputTokens = 0;
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
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
        if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const ev = JSON.parse(line.slice(5));
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ttft < 0) ttft = performance.now() - started;
            if (ev.type === "message_delta" && ev.usage?.output_tokens) outputTokens = ev.usage.output_tokens;
          }
        }
        out.push({ variant, model, ttftMs: Math.round(ttft), totalMs: Math.round(performance.now() - started), outputTokens });
      } catch (err) {
        out.push({ variant, model, ttftMs: -1, totalMs: Math.round(performance.now() - started), outputTokens, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}
