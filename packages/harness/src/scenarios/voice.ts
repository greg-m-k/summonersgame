import type { Scenario } from "../scenario.ts";

/**
 * One player talks to its demon. With --voice the player speaks real audio (VAD, STT, LLM, TTS all
 * run); the typed-chat path is exercised either way. Runs on the keyless mocks: the mock STT only
 * reports that speech happened, so words reach the demon and the game master by typing.
 */
export const voice: Scenario = {
  name: "voice",
  description: "one player talks to its demon: real audio with --voice, typed chat always; works on mocks without keys",
  async run(ctx) {
    const a = await ctx.spawn(ctx.opts.names[0] ?? "Ada", 0);
    const demonUp = await a.waitForDemon(40_000);
    ctx.check("demon joined", Boolean(a.demonIdentity), a.demonIdentity ?? "none");
    ctx.check("demon greeting audio arrived", demonUp && a.demonFrames > 0, `${a.demonFrames} frames`);
    const greeting = await a.waitFor(["demon-said"], 20_000, 0);
    ctx.check("demon greeting transcript received", Boolean(greeting), greeting?.text);
    const mockStt = a.demonMocks.includes("stt");
    ctx.timeline.add("run", `demon pipeline mocks: ${a.demonMocks.join(", ") || "none"}`, a.name);

    if (ctx.opts.voice) {
      const t0 = ctx.timeline.now() + 1; // strictly after the greeting line
      await a.say("Summon a flaming whale with glass teeth. Make it enormous.");
      const heard = await a.waitFor(["demon-heard"], 20_000, t0, (e) => (mockStt ? /unintelligible/i.test(e.text) : /whale/i.test(e.text)));
      ctx.check(
        mockStt ? "mock STT registered the speech (duration only)" : "demon transcribed the whale",
        Boolean(heard),
        heard?.text ?? "no final transcript",
      );
      const reply = await a.waitFor(["demon-said"], 25_000, t0);
      ctx.check("demon replied to the spoken line", Boolean(reply), reply?.text);
      if (mockStt) {
        await ctx.sleep(ctx.gmTimeout);
        ctx.check("mock STT speech never reached the game master", a.myEntities().length === 0, `${a.myEntities().length} entities`);
      } else {
        const summon = await a.waitFor(["summon"], ctx.gmTimeout + 10_000, t0);
        ctx.check("the whale was summoned from voice", Boolean(summon), summon?.text);
      }
    } else {
      ctx.timeline.add("run", "no --voice: skipping the audio-in checks", a.name);
    }

    const t1 = ctx.timeline.now();
    await a.whisper("Summon a glass spider the size of a house.");
    const summon = await a.waitFor(["summon"], ctx.gmTimeout + 10_000, t1);
    ctx.check("typed chat reached the game master (spider summoned)", Boolean(summon), summon?.text);
    const reply2 = await a.waitFor(["demon-said"], 25_000, t1);
    ctx.check("demon answered the typed line", Boolean(reply2), reply2?.text);

    const t2 = ctx.timeline.now();
    await a.whisper("What should I do next? Give me one idea.");
    const reply3 = await a.waitFor(["demon-said"], 25_000, t2);
    ctx.check("demon answers a direct question", Boolean(reply3), reply3?.text);
    await ctx.sleep(3000);
    ctx.check("demon audio recorded for review", a.demonFrames > 50, `${a.demonFrames} frames, saved in the run folder`);
  },
};
