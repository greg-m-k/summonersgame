import { describe, expect, it } from "vitest";
import { DEFAULT_ENVIRONMENT, EntitySpec, SummonInput, WorldEvent, WorldState, decode, emptyWorld, encode } from "./index.ts";

const summon = {
  ownerId: "p1",
  label: "Flaming Whale",
  imagePrompt: "a whale wreathed in orange flames",
  size: 6,
  hp: 300,
  attack: 40,
  speed: 2,
  fx: "fire",
  idleAnim: "float",
  moveStyle: "hover",
  placeholderColor: "#ff6a00",
};

describe("shared schemas", () => {
  it("accepts a valid summon input", () => {
    expect(SummonInput.parse(summon)).toMatchObject({ label: "Flaming Whale" });
  });
  it("rejects a bad color", () => {
    expect(() => SummonInput.parse({ ...summon, placeholderColor: "orange" })).toThrow();
  });
  it("round-trips an event through the data channel encoding", () => {
    const entity: EntitySpec = {
      ...SummonInput.parse(summon),
      id: "e1",
      imageUrl: null,
      maxHp: 300,
      position: { x: 0, y: 0, z: 0 },
      target: null,
      targetEntityId: null,
      bornAt: 1,
    };
    const ev: WorldEvent = { type: "summon", entity };
    expect(WorldEvent.parse(decode(encode(ev)))).toEqual(ev);
  });
  it("parses an empty world", () => {
    const w = WorldState.parse(emptyWorld("r"));
    expect(w.environment.mood).toBe("uneasy violet calm");
  });
});
