import { heartId } from "@summoners/shared";
import { api } from "../api.ts";
import type { Scenario } from "../scenario.ts";

const LINES = [
  "summon a rusted iron golem with a furnace heart",
  "I want a swarm of neon hummingbirds with needle beaks",
  "a glass spider the size of a house",
  "a flaming whale with glass teeth",
];

/**
 * The versus rules: four players split into two teams, one summon each, then nobody speaks. The
 * engine must make the creatures march and fight, wound a heart, pay points, let a demon offer a
 * bribe, end the match when a heart falls, and start the next one. Start the server with a small
 * HEART_HP (400 or so) to keep this under three minutes.
 */
export const versus: Scenario = {
  name: "versus",
  description: "four players, two teams, hearts, autonomous fighting, bribes, match end and reset (HEART_HP=400 recommended)",
  async run(ctx) {
    const names = [0, 1, 2, 3].map((i) => ctx.opts.names[i] ?? ["Ada", "Bo", "Cy", "Di"][i]!);
    const bots = [];
    for (const n of names) bots.push(await ctx.spawn(n));
    const [a] = bots as [NonNullable<(typeof bots)[0]>];
    await ctx.sleep(1500);
    await a.refreshWorld();
    const teams = bots.map((b) => a.world.players[b.identity]?.team ?? "?");
    ctx.check("players split two and two", teams.filter((t) => t === "ash").length === 2 && teams.filter((t) => t === "tide").length === 2, teams.join(", "));
    const hearts = Object.values(a.world.entities).filter((e) => e.heart);
    ctx.check("two hearts stand", hearts.length === 2, hearts.map((h) => `${h.label} ${h.hp}/${h.maxHp}`).join(", "));

    const t0 = ctx.timeline.now();
    for (let i = 0; i < bots.length; i++) await bots[i]!.say(LINES[i]!);
    const summons = await Promise.all(bots.map((b) => b.waitFor(["summon"], ctx.gmTimeout + 20_000, t0, (e) => e.text.includes(b.name))));
    ctx.check("every player's summon appeared", summons.every(Boolean), summons.map((s) => s?.text.split('"')[1] ?? "none").join(", "));

    // From here nobody says a word. The engine has to do everything else.
    const fight = await a.waitFor(["fight"], 45_000, t0);
    ctx.check("creatures engaged on their own, nobody spoke", Boolean(fight), fight?.text);
    await ctx.sleep(15_000);
    await a.refreshWorld();
    const nowHearts = [heartId("ash"), heartId("tide")].map((id) => a.world.entities[id]);
    const hurt = nowHearts.some((h) => !h || h.hp < h.maxHp);
    ctx.check("a heart took damage", hurt, nowHearts.map((h) => (h ? `${h.label} ${h.hp}/${h.maxHp}` : "fallen")).join(", "));
    ctx.check("the engine swung more than ten times", a.autoHits > 10, `${a.autoHits} swings`);
    const paid = await a.waitFor(["points"], 60_000, t0, (e) => /killing|wounding/.test(e.text));
    ctx.check("the engine paid points for a kill or heart damage", Boolean(paid), paid?.text);

    const start = Date.now();
    while (!bots.some((b) => b.secrets.length) && Date.now() - start < 90_000) await ctx.sleep(1000);
    ctx.check("a demon offered someone a bribe", bots.some((b) => b.secrets.length > 0), bots.flatMap((b) => b.secrets).join(" | "));

    const over = await a.waitFor(["match"], 180_000, t0, (e) => e.text.includes("over"));
    ctx.check("a heart fell and the match ended with a reveal", Boolean(over), over?.text);

    // Progression: points became XP, somebody levelled, and a talent point can be spent.
    const levelled = ctx.timeline.entries.find((e) => e.kind === "level");
    ctx.check("someone reached level 2 from points", Boolean(levelled), levelled?.text);
    await a.refreshWorld();
    const climber = bots.find((b) => (a.world.players[b.identity]?.talentPoints ?? 0) > 0);
    if (climber) {
      const before = a.world.players[climber.identity]!;
      const r = await api.talent(climber.session, "sharp_teeth");
      const tal = await a.waitFor(["talent"], 5000, over ? over.t : t0, (e) => e.text.includes(climber.name));
      await a.refreshWorld();
      const after = a.world.players[climber.identity]!;
      ctx.check(
        "a talent point bought Sharp Teeth",
        r.ok && Boolean(tal) && after.talents.includes("sharp_teeth") && after.talentPoints === before.talentPoints - 1,
        r.ok ? `${climber.name}: ${after.talents.join(",")} (${after.talentPoints} left)` : r.reason,
      );
      const r2 = await api.talent(climber.session, "overkill");
      ctx.check("tier 3 refused without tier 2", !r2.ok && /tier 2/.test(r2.reason ?? ""), r2.reason);
    } else {
      ctx.check("a talent point bought Sharp Teeth", false, "nobody had a talent point");
    }
    const next = await a.waitFor(["match"], 30_000, over ? over.t + 1 : t0, (e) => e.text.includes("begins"));
    await a.refreshWorld();
    const creatures = Object.values(a.world.entities).filter((e) => !e.heart).length;
    const fresh = [heartId("ash"), heartId("tide")].every((id) => {
      const h = a.world.entities[id];
      return h && h.hp === h.maxHp;
    });
    ctx.check("the next match started with a clean arena and whole hearts", Boolean(next) && creatures === 0 && fresh, `${creatures} creatures, hearts ${fresh ? "whole" : "not whole"}`);
  },
};
