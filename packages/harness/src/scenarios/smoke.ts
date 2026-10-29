import type { Scenario } from "../scenario.ts";

/** One player: join, get a demon, speak once, watch the dream react, spend mic time. */
export const smoke: Scenario = {
  name: "smoke",
  description: "one player joins, speaks once, earns points, holds the room mic",
  async run(ctx) {
    const a = await ctx.spawn(ctx.opts.names[0] ?? "Ada");
    await a.refreshWorld();
    ctx.check("player appears in world state", Boolean(a.me), a.me ? `persona ${a.me.persona}` : "missing");

    if (ctx.gm === "claude") {
      const demon = await a.waitForDemon(30_000);
      ctx.check("demon joined and spoke (audio frames received)", demon && a.demonFrames > 0, `demon ${a.demonIdentity ?? "none"}, frames ${a.demonFrames}`);
    } else {
      ctx.check("demon dispatched (identity reported)", Boolean(await a.waitForDemon(10_000)), `demon ${a.demonIdentity ?? "none"} (pipeline needs API keys to speak)`);
    }

    const t0 = ctx.timeline.now();
    await a.say("summon a flaming whale with glass teeth");
    const summon = await a.waitFor(["summon"], ctx.gmTimeout, t0);
    ctx.check("speech produced a summon", Boolean(summon), summon ? `${Math.round(summon.t - t0)} ms` : `none within ${ctx.gmTimeout} ms`);
    const mine = a.myEntities();
    ctx.check("summoned entity belongs to the speaker", mine.length > 0, mine.map((e) => e.label).join(", "));
    if (ctx.gm === "claude") {
      ctx.check("entity label mentions the whale", mine.some((e) => /whale/i.test(e.label) || /whale/i.test(e.imagePrompt)), mine.map((e) => e.label).join(", "));
    }
    const narrate = await a.waitFor(["narrate"], ctx.gmTimeout, t0);
    ctx.check("game master narrated", Boolean(narrate), narrate?.text);
    const points = await a.waitFor(["points"], ctx.gmTimeout, t0, (e) => e.text.includes(a.name));
    ctx.check("points were awarded for the summon", Boolean(points), points?.text);

    await a.refreshWorld();
    const bank = a.me?.micBank ?? 0;
    if (bank > 0) {
      const t1 = ctx.timeline.now();
      const r = await a.holdMic(2);
      ctx.check("room mic accepted", r.ok, r.reason);
      const on = await a.waitFor(["mic"], 3000, t1, (e) => e.text.includes("ON"));
      const off = await a.waitFor(["mic"], 3000, t1, (e) => e.text.includes("off"));
      ctx.check("mic_time on then off broadcast", Boolean(on && off));
      await a.refreshWorld();
      const after = a.me?.micBank ?? 0;
      ctx.check("mic bank drained while held", after < bank, `${bank}s -> ${after}s`);
    } else {
      ctx.check("mic bank available after points", false, "bank is 0");
    }
  },
};
