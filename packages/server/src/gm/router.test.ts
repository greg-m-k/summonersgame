import { describe, expect, it } from "vitest";
import { mockClassify } from "./router.ts";

describe("mockClassify (keyless router)", () => {
  it("sends concrete wishes to the game master and keeps chatter away from it", () => {
    expect(mockClassify("summon a flaming whale with glass teeth").kind).toBe("summon");
    expect(mockClassify("I want a swarm of neon hummingbirds").kind).toBe("summon");
    expect(mockClassify("make it bigger and give it wings").kind).toBe("transform");
    expect(mockClassify("my whale attacks the hummingbirds").kind).toBe("attack");
    expect(mockClassify("turn the sky blood red").kind).toBe("warp");
    expect(mockClassify("testing").kind).toBe("chatter");
    expect(mockClassify("hey what do I do next?").kind).toBe("chatter");
  });

  it("recognises a talent pick by name", () => {
    const t = mockClassify("take sharp teeth");
    expect(t.kind).toBe("talent");
    expect(t.talentId).toBe("sharp_teeth");
    expect(mockClassify("I want thick hide").talentId).toBe("thick_hide");
  });
});
