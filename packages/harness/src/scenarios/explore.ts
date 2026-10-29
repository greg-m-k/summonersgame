import { PERSONALITIES } from "../brain.ts";
import type { Scenario } from "../scenario.ts";

/**
 * Claude plays N players with different personalities for R rounds, then a critic reviews the log.
 * This is the "understand the game" mode: read runs/<id>/report.md afterwards.
 */
export const explore: Scenario = {
  name: "explore",
  description: "LLM-driven players improvise for several rounds; a critic assesses the session",
  async run(ctx) {
    const n = Math.max(1, Math.min(6, ctx.opts.players));
    const bots = [];
    for (let i = 0; i < n; i++) {
      const name = ctx.opts.names[i] ?? ["Ada", "Bo", "Cy", "Dee", "Eli", "Fox"][i]!;
      bots.push({ bot: await ctx.spawn(name, i), personality: PERSONALITIES[i % PERSONALITIES.length]! });
      ctx.timeline.add("persona", `${name} plays as ${PERSONALITIES[i % PERSONALITIES.length]}`);
    }
    await ctx.sleep(2000);
    if (ctx.gm === "claude") {
      await Promise.all(bots.map((b) => b.bot.waitForDemon(20_000)));
    }

    let summonsBefore = 0;
    for (let round = 1; round <= ctx.opts.rounds; round++) {
      ctx.timeline.add("round", `--- round ${round} ---`);
      for (const { bot, personality } of bots) {
        await bot.refreshWorld();
        const me = bot.me;
        const d = await ctx.brain.decide({ name: bot.name, personality, micBank: me?.micBank ?? 0, score: me?.score ?? 0 }, ctx.timeline, round);
        ctx.timeline.add("think", d.reasoning, bot.name);
        await bot.say(d.utterance);
        if (d.holdMic && (me?.micBank ?? 0) >= 3) {
          const hold = bot.holdMic(3);
          if (ctx.opts.voice && d.micLine) {
            await ctx.sleep(400);
            await bot.say(d.micLine);
          } else if (d.micLine) {
            ctx.timeline.add("mic-line", `(to humans) "${d.micLine}"`, bot.name);
          }
          await hold;
        }
        await ctx.sleep(ctx.gm === "claude" ? 1500 : 400);
      }
      // Let the game master catch up before the next round.
      await ctx.sleep(ctx.gm === "claude" ? 9000 : 1500);
      const summons = ctx.timeline.entries.filter((e) => e.kind === "summon").length;
      ctx.check(`round ${round} produced world events`, summons > summonsBefore || ctx.timeline.entries.some((e) => e.t > 0 && ["attack", "transform", "warp"].includes(e.kind)), `${summons - summonsBefore} new summons`);
      summonsBefore = summons;
    }

    await bots[0]!.bot.refreshWorld();
    const w = bots[0]!.bot.world;
    ctx.check("every player scored at least once", Object.values(w.players).every((p) => p.score > 0), Object.values(w.players).map((p) => `${p.name} ${p.score}`).join(", "));
    ctx.check("entity count stayed under the cap", Object.keys(w.entities).length <= 40, `${Object.keys(w.entities).length} entities`);
  },
};
