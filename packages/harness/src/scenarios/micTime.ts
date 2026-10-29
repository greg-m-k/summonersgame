import type { Scenario } from "../scenario.ts";

/**
 * Proves the audio gating: B cannot hear A until A holds the room mic, hears A while held, and
 * stops hearing A after release. Uses a test tone so no TTS is needed.
 */
export const micTime: Scenario = {
  name: "mic-time",
  description: "two players; room mic gating is verified with real audio frames",
  async run(ctx) {
    const [a, b] = await Promise.all([ctx.spawn(ctx.opts.names[0] ?? "Ada", 0), ctx.spawn(ctx.opts.names[1] ?? "Bo", 1)]);
    await ctx.sleep(1500);

    // Earn bank for A: a point pays only a couple of seconds now, so two summons.
    const t0 = ctx.timeline.now();
    await a.say("summon a thunderous brass elephant");
    const pts = await a.waitFor(["points"], ctx.gmTimeout, t0, (e) => e.text.includes(a.name) || e.text.includes(a.identity));
    ctx.check("A earned mic time", Boolean(pts), pts?.text);
    const t0b = ctx.timeline.now();
    await a.say("and a velvet moth the size of a barn");
    await a.waitFor(["points"], ctx.gmTimeout, t0b, (e) => e.text.includes(a.name) || e.text.includes(a.identity));
    await a.refreshWorld();
    const bank = a.me?.micBank ?? 0;
    if (bank < 3) {
      ctx.check("enough bank to test (>=3s)", false, `${bank}s`);
      return;
    }

    // Before: B must not hear A even though A is making noise.
    await a.playTone(1.5);
    await ctx.sleep(500);
    ctx.check("B hears nothing from A before mic time", b.heard(a.identity) === 0, `${b.heard(a.identity)} frames`);

    // During: hold and make noise at the same time.
    const t1 = ctx.timeline.now();
    const hold = a.holdMic(3);
    await ctx.sleep(600);
    await a.playTone(2);
    await hold;
    const on = await b.waitFor(["mic"], 2000, t1, (e) => e.text.includes(a.name) && e.text.includes("ON"));
    ctx.check("B saw A's mic_time ON", Boolean(on), on?.text);
    const during = b.heard(a.identity);
    ctx.check("B received A's audio while A held the mic", during > 0, `${during} non-silent frames`);

    // After: released, B unsubscribes, more noise must not arrive.
    const off = await b.waitFor(["mic"], 2000, t1, (e) => e.text.includes(a.name) && e.text.includes("off"));
    ctx.check("B saw A's mic_time off", Boolean(off), off?.text);
    await ctx.sleep(400);
    await a.playTone(1.5);
    await ctx.sleep(500);
    ctx.check("B hears nothing from A after release", b.heard(a.identity) === during, `${b.heard(a.identity)} frames (was ${during})`);

    await a.refreshWorld();
    const after = a.me?.micBank ?? 0;
    ctx.check("bank drained roughly 3s", bank - after >= 2 && bank - after <= 4, `${bank}s -> ${after}s`);
    ctx.check("A no longer on room mic", a.me?.onRoomMic === false);
  },
};
