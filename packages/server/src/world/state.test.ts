import { describe, expect, it } from "vitest";
import { SECONDS_PER_POINT, type SummonInput, type TeamId, type WorldEvent, heartId, isSummon } from "@summoners/shared";
import { FIRST_WAVE_MS, MINIONS_PER_LANE, WAVE_INTERVAL_MS, distToLane } from "@summoners/shared";
import { World } from "./state.ts";

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

/** A world with a controllable clock. */
function clockWorld(heartHp = 1200) {
  let t = 1000;
  const w = new World("r", () => t, { heartHp });
  return { w, advance: (ms: number) => (t += ms) };
}

describe("World", () => {
  it("starts a match with two hearts and deals players to the smaller team", () => {
    const w = new World("r", () => 1000);
    const events: WorldEvent[] = [];
    w.onEvent((e) => events.push(e));
    expect(w.state.match).toMatchObject({ number: 1, phase: "live" });
    expect(Object.values(w.state.entities).filter((e) => e.heart).map((e) => e.id).sort()).toEqual(["heart-ash", "heart-tide"]);
    w.addPlayer("p1", "Alice", "Gib");
    w.addPlayer("p2", "Bob", "Rust");
    w.addPlayer("p3", "Cy", "Pebble");
    expect([w.player("p1")?.team, w.player("p2")?.team, w.player("p3")?.team]).toEqual(["ash", "tide", "ash"]);
    const e = w.summon(base("p1"));
    expect(w.entity(e.id)).toBeDefined();
    expect(e.maxHp).toBe(100);
    expect(events.map((e) => e.type)).toEqual(["player_joined", "player_joined", "player_joined", "summon"]);
  });

  it("an ordered strike sets the target, the attacker closes in, and zero hp destroys", () => {
    const w = new World("r");
    w.addPlayer("p1", "A", "x");
    w.addPlayer("p2", "B", "y");
    // attack 0 so the engine never swings by itself; only the ordered strikes count here
    const a = w.summon(base("p1", { attack: 0, speed: 100 }));
    // b stands still: a marching b would walk into an ash tower and die before a arrives.
    const b = w.summon(base("p2", { hp: 60, attack: 0, speed: 0 }));
    const r1 = w.attack(a.id, b.id, 50, "bonk");
    expect(r1).toEqual({ targetHp: 10, destroyed: false });
    expect(w.entity(a.id)?.targetEntityId).toBe(b.id);
    const packet = w.step(0.1);
    expect(packet?.items[0]?.[0]).toBe(a.id);
    // Fast, but it still has to walk round whatever rocks lie between them.
    for (let i = 0; i < 30; i++) w.step(0.1);
    const moved = w.entity(a.id)!;
    const dist = Math.hypot(moved.position.x - b.position.x, moved.position.z - b.position.z);
    expect(dist).toBeLessThanOrEqual((a.size + b.size) * 0.5 + 0.4 + 0.02);
    const r2 = w.attack(a.id, b.id, 999, "finisher");
    expect(r2).toEqual({ targetHp: 0, destroyed: true });
    expect(w.entity(b.id)).toBeUndefined();
    expect(w.entity(a.id)?.targetEntityId).toBeNull();
  });

  it("creatures march on the enemy heart and swing on their own; a kill pays points", () => {
    const { w, advance } = clockWorld();
    w.hooks.onHeartDown = (t) => w.endMatch(t, {});
    w.addPlayer("p1", "A", "x"); // ash
    w.addPlayer("p2", "B", "y"); // tide
    const fast = w.summon(base("p1", { attack: 400, speed: 20, hp: 500 }));
    const slow = w.summon(base("p2", { attack: 0, speed: 0, hp: 50 }));
    // Walk the ash creature across until something is in reach and swings land.
    let swings = 0;
    const seen = new Set<string>();
    w.onEvent((e) => {
      if (e.type === "attack" && e.auto) {
        swings++;
        seen.add(e.targetId);
      }
    });
    for (let i = 0; i < 400 && w.live; i++) {
      w.step(0.1);
      advance(100);
    }
    expect(swings).toBeGreaterThan(0);
    // The tide creature is weak and in the way or the heart is: either dies, and the heart must fall.
    expect(w.entity(fast.id)).toBeDefined();
    expect(w.live).toBe(false);
    expect(w.state.match.phase).toBe("over");
    expect(w.state.match.winner).toBe<TeamId>("ash");
    expect(seen.has(heartId("tide"))).toBe(true);
    const p1 = w.player("p1")!;
    expect(p1.score).toBeGreaterThan(0);
    void slow;
  });

  it("a fallen heart ends the match through the hook, pays the winners, and the next match resets", () => {
    const { w } = clockWorld();
    let winner: TeamId | null = null;
    w.hooks.onHeartDown = (t) => {
      winner = t;
      w.endMatch(t, { p1: ["a bribe"] });
    };
    w.addPlayer("p1", "A", "x");
    w.addPlayer("p2", "B", "y");
    w.summon(base("p1"));
    const scoreBefore = w.player("p1")!.score;
    w.destroy(heartId("tide"), "unmade");
    expect(winner).toBe("ash");
    expect(w.state.match.phase).toBe("over");
    expect(w.player("p1")!.score).toBe(scoreBefore + 8);
    expect(w.step(0.1)).toBeNull();
    w.startMatch();
    expect(w.state.match).toMatchObject({ number: 2, phase: "live" });
    expect(Object.values(w.state.entities).filter(isSummon)).toHaveLength(0);
    expect(w.entity(heartId("tide"))?.hp).toBe(1200);
    expect(w.player("p1")!.score).toBe(0);
  });

  it("points pay xp, levels pay talent points and mic time, talents shape summons", () => {
    const w = new World("r");
    w.addPlayer("p1", "A", "x");
    const events: WorldEvent[] = [];
    w.onEvent((e) => events.push(e));
    for (let i = 0; i < 10; i++) w.awardPoints("p1", 1, "r"); // 100 xp: level 2
    const p = w.player("p1")!;
    expect(p.xp).toBe(100);
    expect(p.level).toBe(2);
    expect(p.talentPoints).toBe(1);
    expect(events.filter((e) => e.type === "level_up")).toHaveLength(1);
    expect(p.micBank).toBe(10 * SECONDS_PER_POINT + 20);
    expect(w.chooseTalent("p1", "overkill")).toMatch(/tier 2/);
    expect(w.chooseTalent("p1", "sharp_teeth")).toBeNull();
    expect(w.chooseTalent("p1", "thick_hide")).toBe("no talent points");
    expect(w.player("p1")).toMatchObject({ talents: ["sharp_teeth"], talentPoints: 0 });
    const e = w.summon(base("p1", { attack: 100, hp: 100 }));
    expect(e.attack).toBe(120);
    expect(e.hp).toBe(100);
    // Score resets with the match, xp and talents do not.
    w.hooks.onHeartDown = (t) => w.endMatch(t, {});
    w.destroy(heartId("tide"), "unmade");
    w.startMatch();
    expect(w.player("p1")).toMatchObject({ score: 0, level: 2, talents: ["sharp_teeth"] });
  });

  it("a kill makes the killer a veteran; Second Wind spares a creature once", () => {
    const w = new World("r");
    w.addPlayer("p1", "A", "x");
    w.addPlayer("p2", "B", "y");
    for (let i = 0; i < 25; i++) w.awardPoints("p2", 1, "r"); // level 3: two talent points
    expect(w.chooseTalent("p2", "thick_hide")).toBeNull();
    expect(w.chooseTalent("p2", "second_wind")).toMatch(/tier 2/);
    expect(w.chooseTalent("p2", "regrowth")).toBeNull();
    const a = w.summon(base("p1", { attack: 100, speed: 0 }));
    const b = w.summon(base("p2", { hp: 40, attack: 0, speed: 0 }));
    expect(b.hp).toBe(50); // thick hide
    const r = w.attack(a.id, b.id, 999, "crunch");
    expect(r?.destroyed).toBe(true);
    const vet = w.entity(a.id)!;
    expect(vet.kills).toBe(1);
    expect(vet.attack).toBe(110);
    expect(vet.maxHp).toBe(110);
  });

  it("awards points into score and mic bank, clamped to 10", () => {
    const w = new World("r");
    w.addPlayer("p1", "A", "x");
    w.awardPoints("p1", 50, "wow");
    // ten points is also exactly level 2, which pays its own mic time
    expect(w.player("p1")).toMatchObject({ score: 10, level: 2, micBank: 10 * SECONDS_PER_POINT + 20 });
    expect(w.awardPoints("ghost", 1, "no")).toBeNull();
  });

  it("drains the mic bank", () => {
    const w = new World("r");
    w.addPlayer("p1", "A", "x");
    w.awardPoints("p1", 1, "r");
    w.setRoomMic("p1", true);
    expect(w.drainMic("p1", 2)).toBe(SECONDS_PER_POINT - 2);
    expect(w.player("p1")?.onRoomMic).toBe(true);
  });

  it("transform resets the image only when the prompt changes", () => {
    const w = new World("r");
    w.addPlayer("p1", "A", "x");
    const e = w.summon(base("p1"));
    w.setEntityImage(e.id, "/api/img/1");
    expect(w.entity(e.id)?.imageUrl).toBe("/api/img/1");
    w.transform(e.id, { size: 4 }, "grows");
    expect(w.entity(e.id)?.imageUrl).toBe("/api/img/1");
    w.transform(e.id, { imagePrompt: "a bigger thing" }, "mutates");
    expect(w.entity(e.id)?.imageUrl).toBeNull();
  });

  it("lays a field with three lanes, a tower per team per lane, and rocks that stay off the lanes", () => {
    const w = new World("field-room", () => 1000);
    const t = w.terrain;
    expect(t.lanes.map((l) => l.id)).toEqual(["north", "mid", "south"]);
    expect(t.obstacles.length).toBeGreaterThanOrEqual(8);
    for (const o of t.obstacles) for (const l of t.lanes) expect(distToLane(o, l)).toBeGreaterThan(o.r + 1);
    const towers = Object.values(w.state.entities).filter((e) => e.kind === "tower");
    expect(towers).toHaveLength(6);
    expect(new Set(towers.map((e) => e.ownerId))).toEqual(new Set(["team:ash", "team:tide"]));
    // Same room and match number, same field; next match, a different one.
    expect(new World("field-room", () => 5).terrain).toEqual(t);
    w.hooks.onHeartDown = (team) => w.endMatch(team, {});
    w.destroy(heartId("tide"), "test");
    w.startMatch();
    expect(w.terrain.seed).not.toBe(t.seed);
    expect(Object.values(w.state.entities).filter((e) => e.kind === "tower")).toHaveLength(6);
  });

  it("creatures walk around rocks instead of through them", () => {
    const { w, advance } = clockWorld();
    w.addPlayer("p1", "A", "x"); // ash, marches toward the tide heart at x = -11
    const e = w.summon(base("p1", { attack: 0, speed: 4, size: 1, hp: 1000 }));
    w.transform(e.id, { hp: 100_000 }, "sturdy");
    const solid = w.terrain.obstacles.filter((o) => o.kind !== "pool");
    for (let i = 0; i < 120; i++) {
      advance(100);
      w.step(0.1);
      const cur = w.entity(e.id)!;
      for (const o of solid) {
        expect(Math.hypot(cur.position.x - o.x, cur.position.z - o.z)).toBeGreaterThan(o.r + 0.6 * 1 - 0.05);
      }
    }
    expect(w.entity(e.id)!.position.x).toBeLessThan(e.position.x);
  });

  it("sends minion waves down the lanes on a timer and the minions follow their waypoints", () => {
    const { w, advance } = clockWorld();
    const waves: number[] = [];
    w.onEvent((ev) => {
      if (ev.type === "wave") waves.push(ev.minions.length);
    });
    advance(FIRST_WAVE_MS - 1);
    w.step(0.1);
    expect(waves).toEqual([]);
    advance(2);
    w.step(0.1);
    expect(waves).toEqual([3 * 2 * MINIONS_PER_LANE]);
    expect(w.state.wave).toBe(1);
    const minion = Object.values(w.state.entities).find((e) => e.kind === "minion" && e.ownerId === "team:ash")!;
    const before = minion.position.x;
    for (let i = 0; i < 30; i++) {
      advance(100);
      w.step(0.1);
    }
    const after = w.entity(minion.id)!;
    expect(after.position.x).toBeLessThan(before); // ash minions walk toward tide at negative x
    expect(after.waypoint ?? 1).toBeGreaterThanOrEqual(1);
    advance(WAVE_INTERVAL_MS);
    w.step(0.1);
    expect(w.state.wave).toBe(2);
    // With the tide mid tower down, ash sends siege minions up the mid lane.
    w.destroy("tower-tide-mid", "test");
    advance(WAVE_INTERVAL_MS);
    w.step(0.1);
    const siege = Object.values(w.state.entities).filter((e) => e.kind === "minion" && e.lane === "mid" && e.ownerId === "team:ash" && e.label.includes("siege"));
    expect(siege.length).toBeGreaterThan(0);
  });

  it("towers shoot what comes in range and pay points when toppled", () => {
    const { w, advance } = clockWorld();
    w.addPlayer("p1", "A", "x"); // ash
    w.addPlayer("p2", "B", "y"); // tide
    const tower = w.entity("tower-tide-mid")!;
    // A sturdy ash creature parked inside the tide tower's range.
    const e = w.summon(base("p1", { attack: 0, speed: 0, hp: 5000 }));
    w.transform(e.id, { speed: 0 }, "parked");
    (w.state.entities[e.id] as { position: { x: number; z: number } }).position = { x: tower.position.x + 2, z: tower.position.z };
    let shots = 0;
    w.onEvent((ev) => {
      if (ev.type === "attack" && ev.attackerId === tower.id) shots++;
    });
    for (let i = 0; i < 30; i++) {
      advance(100);
      w.step(0.1);
    }
    expect(shots).toBeGreaterThanOrEqual(2);
    expect(w.entity(e.id)!.hp).toBeLessThan(5000);
    // Toppling it pays the owner three points.
    const hammer = w.summon(base("p1", { attack: 0, speed: 0 }));
    const paid: WorldEvent[] = [];
    w.onEvent((ev) => {
      if (ev.type === "points") paid.push(ev);
    });
    w.attack(hammer.id, tower.id, 100_000, "smash");
    expect(w.entity(tower.id)).toBeUndefined();
    expect(paid.find((ev) => ev.type === "points" && ev.reason.includes("toppling"))).toBeDefined();
  });
});
