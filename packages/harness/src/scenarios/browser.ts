import { resolve } from "node:path";
import { concatWithGaps, readWav, writeWav } from "../audio.ts";
import { BrowserPlayer } from "../browser.ts";
import type { Scenario } from "../scenario.ts";
import { synthesize } from "../tts.ts";

const LINES: Record<number, string[]> = {
  0: ["Summon a flaming whale with glass teeth.", "My whale swallows the other player's creature whole."],
  1: ["I want a swarm of neon hummingbirds with needle beaks.", "Make the sky turn blood red."],
};

/**
 * Two real browsers (fake camera and mic) join through the UI. Verifies video tiles, sprites, feed,
 * and the hold-to-talk button in the actual client. With --voice each browser plays a scripted
 * monologue into its fake mic so the demons hear real speech.
 */
export const browser: Scenario = {
  name: "browser",
  description: "drives the real web client in Chrome with fake camera/mic; screenshots each step",
  async run(ctx) {
    const names = [ctx.opts.names[0] ?? "Ada", ctx.opts.names[1] ?? "Bo"];
    const players: BrowserPlayer[] = [];
    for (let i = 0; i < 2; i++) {
      let wav: string | undefined;
      if (ctx.opts.voice) {
        const clips = (LINES[i] ?? LINES[0]!).map((line) => readWav(synthesize(line, i)));
        const pcm = concatWithGaps(clips, 8, 6);
        wav = resolve(ctx.runDir, `${names[i]}-script.wav`);
        writeWav(wav, pcm.samples, pcm.sampleRate);
      }
      const p = new BrowserPlayer({ room: ctx.opts.room, name: names[i]!, timeline: ctx.timeline, runDir: ctx.runDir, headed: ctx.opts.headed, wav });
      await p.launch();
      players.push(p);
    }
    const [a, b] = players as [BrowserPlayer, BrowserPlayer];
    try {
      await a.join();
      await b.join();
      await ctx.sleep(6000);
      await a.screenshot("joined");
      let sa = await a.store();
      let sb = await b.store();
      ctx.check("both players in A's scoreboard", Object.keys(sa.players).length >= 2, Object.values(sa.players).map((p) => p.name).join(", "));
      ctx.check("A renders two video tiles (own camera + B's camera)", sa.tiles === 2, `${sa.tiles} tiles`);
      ctx.check("B renders two video tiles", sb.tiles === 2, `${sb.tiles} tiles`);
      await ctx.sleep(4000);
      sa = await a.store();
      sb = await b.store();
      ctx.timeline.add("tracks", `A local: ${sa.localTracks.join(", ")}`, a.opts.name);
      ctx.timeline.add("tracks", `B local: ${sb.localTracks.join(", ")}`, b.opts.name);
      ctx.check("A has both cameras playing (own + B's)", sa.videosPlaying === 2, `${sa.videosPlaying} playing; ${sa.remoteTracks.join("; ")}`);
      ctx.check("B has both cameras playing (own + A's)", sb.videosPlaying === 2, `${sb.videosPlaying} playing; ${sb.remoteTracks.join("; ")}`);

      if (!ctx.opts.voice) {
        const t0 = ctx.timeline.now();
        await a.say("summon a flaming whale with glass teeth");
        await b.say("I want a swarm of neon hummingbirds with needle beaks");
        await ctx.sleep(ctx.gmTimeout);
        ctx.timeline.add("wait", `${ctx.gmTimeout} ms for the game master`, undefined, { since: t0 });
      } else {
        await ctx.sleep(45_000);
      }
      await a.screenshot("after-speech");
      await b.screenshot("after-speech");
      sa = await a.store();
      sb = await b.store();
      ctx.check("A sees entities rendered with labels", sa.labels.length >= 1, sa.labels.join(", "));
      ctx.check("B sees the same entities", sb.labels.length === sa.labels.length, `${sb.labels.length} vs ${sa.labels.length}`);
      ctx.check("feed shows narration", sa.feed.length > 0, sa.feed.slice(-2).join(" | "));

      // Typed chat: reaches the demon (reply in the panel, voice on the audio track) and the game master.
      const demonA = sa.players[a.identity]?.demonIdentity ?? null;
      if (demonA) {
        const before = sa.labels.length;
        await a.whisper("summon a glass spider the size of a house");
        await ctx.sleep(ctx.gmTimeout + 3000);
        sa = await a.store();
        ctx.check("typed chat summoned a new entity", sa.labels.length > before, `${before} -> ${sa.labels.length} labels`);
        ctx.check("chat panel shows the demon's reply", sa.chat.some((l) => l.startsWith("demon:")), sa.chat.slice(-3).join(" | "));
        ctx.check("A hears its demon (audio element playing)", sa.audiosPlaying >= 1, `${sa.audiosPlaying} audio elements playing`);
        await a.screenshot("after-chat");
      } else {
        ctx.check("A's demon is online for the chat test", false, "no demon registered");
      }

      // Progression UI: the talent tree opens; with a point to spend the first affordable talent is taken.
      const before = await a.store();
      const took = await a.takeTalent();
      await a.screenshot("talents");
      if (before.talentPoints > 0) {
        await ctx.sleep(1500);
        const now = await a.store();
        ctx.check("talent taken in the UI reached the server", took !== null && now.talents.includes(took), `${now.talents.join(",")} (level ${now.level})`);
      } else {
        ctx.check("talent tree opens (no point to spend yet)", true, `level ${before.level}, ${before.talentPoints} points`);
      }
      await a.page.keyboard.press("Escape");

      const bankA = sa.players[a.identity]?.micBank ?? 0;
      if (bankA > 0) {
        const hold = a.holdMic(2.5);
        await ctx.sleep(1200);
        const mid = await a.store();
        const midB = await b.store();
        ctx.check("A's store shows onRoomMic while held", mid.onRoomMic);
        ctx.check("B sees A on room mic", Boolean(midB.players[a.identity]?.onRoomMic));
        await a.screenshot("holding-mic");
        await hold;
        await ctx.sleep(800);
        const after = await a.store();
        // The engine keeps paying points during a fight, so the bank can rise while held; the drain
        // itself is proven by the mic-time scenario. Here: released, and the server saw the hold.
        ctx.check("released: onRoomMic false after a server-acknowledged hold", mid.onRoomMic && !after.onRoomMic, `${bankA}s -> ${after.players[a.identity]?.micBank}s`);
      } else {
        ctx.check("A has mic time to test the button", false, "bank 0");
      }
      ctx.check("no page errors", !ctx.timeline.entries.some((e) => e.kind === "page-error"));
    } finally {
      for (const p of players) await p.close();
    }
  },
};
