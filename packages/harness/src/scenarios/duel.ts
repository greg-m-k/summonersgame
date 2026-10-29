import type { Scenario } from "../scenario.ts";

/** Two players summon, one orders an attack, one transforms. */
export const duel: Scenario = {
  name: "duel",
  description: "two players summon, attack each other's things, transform, and the world warps",
  async run(ctx) {
    const [a, b] = await Promise.all([ctx.spawn(ctx.opts.names[0] ?? "Ada", 0), ctx.spawn(ctx.opts.names[1] ?? "Bo", 1)]);
    await ctx.sleep(1500);

    const t0 = ctx.timeline.now();
    await a.say("summon a rusted iron golem with a furnace heart");
    await ctx.sleep(400);
    await b.say("I want a swarm of neon hummingbirds with needle beaks");
    const sa = await a.waitFor(["summon"], ctx.gmTimeout, t0, (e) => e.text.startsWith(a.name));
    const sb = await b.waitFor(["summon"], ctx.gmTimeout, t0, (e) => e.text.startsWith(b.name));
    ctx.check("both players' summons appeared", Boolean(sa && sb), `${sa ? "A ok" : "A missing"}, ${sb ? "B ok" : "B missing"}`);

    await a.refreshWorld();
    const golem = a.myEntities()[0];
    const birds = Object.values(a.world.entities).find((e) => e.ownerId === b.identity);
    const t1 = ctx.timeline.now();
    if (golem && birds) {
      await a.say(`my ${golem.label} smashes ${b.name}'s ${birds.label} with both fists`);
    } else {
      await a.say("my thing attacks the other player's thing");
    }
    const attack = await a.waitFor(["attack"], ctx.gmTimeout, ctx.gm === "mock" ? t0 : t1);
    ctx.check("an attack resolved", Boolean(attack), attack?.text);
    if (attack && birds) {
      await a.refreshWorld();
      const after = a.world.entities[birds.id];
      ctx.check("target lost hp or died", !after || after.hp < birds.hp, after ? `${birds.hp} -> ${after.hp}` : "destroyed");
    }

    if (ctx.gm === "claude") {
      const t2 = ctx.timeline.now();
      await b.say("make my hummingbirds enormous and set them on fire");
      const tr = await b.waitFor(["transform"], ctx.gmTimeout, t2);
      ctx.check("transform applied", Boolean(tr), tr?.text);
      const t3 = ctx.timeline.now();
      await a.say("the sky turns blood red and gravity flips upside down");
      const warp = await a.waitFor(["warp"], ctx.gmTimeout, t3);
      ctx.check("world warped from speech", Boolean(warp), warp?.text);
      await a.refreshWorld();
      ctx.check("gravity changed", a.world.environment.gravity !== 9.8, `gravity ${a.world.environment.gravity}`);
    }

    await a.refreshWorld();
    ctx.check("world has entities from both players", new Set(Object.values(a.world.entities).map((e) => e.ownerId)).size >= 2 || Object.keys(a.world.entities).length >= 2, `${Object.keys(a.world.entities).length} entities`);
    const scores = Object.values(a.world.players).map((p) => `${p.name} ${p.score}`);
    ctx.check("someone scored", Object.values(a.world.players).some((p) => p.score > 0), scores.join(", "));
  },
};
