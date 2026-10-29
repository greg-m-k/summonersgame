import { describe, expect, it } from "vitest";
import { type DemonMessage, SECONDS_PER_POINT, type SecretMessage, type SummonInput } from "@summoners/shared";
import { Temptations } from "./temptations.ts";
import { World } from "./world/state.ts";

const base = (ownerId: string, over: Partial<SummonInput> = {}): SummonInput => ({
  ownerId,
  label: "Thing",
  imagePrompt: "a thing",
  size: 2,
  hp: 100,
  attack: 10,
  speed: 5,
  fx: "none",
  idleAnim: "bob",
  moveStyle: "walk",
  placeholderColor: "#ffffff",
  ...over,
});

function setup() {
  let t = 100_000;
  const w = new World("r", () => t);
  const toDemon: Array<{ playerId: string; msg: DemonMessage }> = [];
  const toPlayer: Array<{ playerId: string; msg: SecretMessage }> = [];
  const temps = new Temptations(
    w,
    { toDemon: (playerId, msg) => toDemon.push({ playerId, msg }), toPlayer: (playerId, msg) => toPlayer.push({ playerId, msg }) },
    () => t,
  );
  w.onEvent((ev) => temps.onEvent(ev));
  w.addPlayer("p1", "A", "x");
  w.addPlayer("p2", "B", "y");
  w.addPlayer("p3", "C", "z"); // ash, teammate of p1
  for (const id of ["p1", "p2", "p3"]) w.setDemon(id, `agent-${id}`);
  return { w, temps, toDemon, toPlayer, advance: (ms: number) => (t += ms), now: () => t };
}

/** Tick until the player has an open offer, with the clock running. */
function waitForOffer(s: ReturnType<typeof setup>, playerId: string, maxSeconds = 200) {
  for (let i = 0; i < maxSeconds; i++) {
    s.temps.tick();
    const offer = s.toPlayer.find((m) => m.playerId === playerId && m.msg.type === "temptation");
    if (offer) return offer.msg as Extract<SecretMessage, { type: "temptation" }>;
    s.advance(1000);
  }
  return null;
}

describe("Temptations", () => {
  it("offers a deal to a player with a demon after a while, to the demon and the player alike", () => {
    const s = setup();
    const offer = waitForOffer(s, "p1");
    expect(offer).not.toBeNull();
    expect(s.toDemon.some((m) => m.playerId === "p1" && m.msg.type === "temptation" && m.msg.id === offer!.id)).toBe(true);
    expect(offer!.rewardSeconds % SECONDS_PER_POINT).toBe(0);
  });

  it("pays a summon-word deal when the next summon carries the word, and reveals it at the end", () => {
    const s = setup();
    let offer = waitForOffer(s, "p1");
    // Keep rolling offers until the word deal comes up (p1 has no creature yet, so no destroy_own).
    for (let guard = 0; guard < 40 && offer && !/must have/.test(offer.text); guard++) {
      s.advance(61_000);
      s.temps.tick(); // expires it
      s.toPlayer.length = 0;
      offer = waitForOffer(s, "p1");
    }
    expect(offer?.text).toMatch(/must have "(\w+)"/);
    const word = /must have "(\w+)"/.exec(offer!.text)![1]!;
    const before = s.w.player("p1")!.score;
    s.w.summon(base("p1", { label: `A ${word} golem` }));
    expect(s.w.player("p1")!.score).toBeGreaterThan(before);
    expect(s.toPlayer.at(-1)?.msg).toMatchObject({ type: "temptation_result", success: true });
    // Silence deals rolled past in the loop above also count as taken (the player never spoke).
    expect(s.temps.bribesTaken().p1).toContain(offer!.text);
    s.temps.reset();
    expect(s.temps.bribesTaken()).toEqual({});
  });

  it("a silence deal fails the moment the player speaks", () => {
    const s = setup();
    let offer = waitForOffer(s, "p2");
    for (let guard = 0; guard < 40 && offer && !/Say nothing/.test(offer.text); guard++) {
      s.advance(61_000);
      s.temps.tick();
      s.toPlayer.length = 0;
      offer = waitForOffer(s, "p2");
    }
    expect(offer?.text).toMatch(/Say nothing/);
    s.temps.onTranscript("p2");
    expect(s.toPlayer.at(-1)?.msg).toMatchObject({ type: "temptation_result", success: false, id: offer!.id });
  });
});
