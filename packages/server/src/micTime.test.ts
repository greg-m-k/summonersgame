import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECONDS_PER_POINT } from "@summoners/shared";
import { MicController } from "./micTime.ts";
import { World } from "./world/state.ts";

describe("MicController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refuses with an empty bank, drains while held, and cuts off at zero", async () => {
    const w = new World("r");
    w.addPlayer("p1", "A", "x");
    const calls: Array<[string, boolean]> = [];
    const mic = new MicController(w, { setDemonHearsPlayer: async (id, hears) => void calls.push([id, hears]) }, 1000);

    expect(await mic.request("p1", true)).toEqual({ ok: false, reason: "no mic time" });
    w.awardPoints("p1", 3, "r");
    const bank = 3 * SECONDS_PER_POINT; // 6 seconds
    expect(w.player("p1")?.micBank).toBe(bank);
    expect(await mic.request("p1", true)).toEqual({ ok: true });
    expect(w.player("p1")?.onRoomMic).toBe(true);
    expect(calls).toEqual([["p1", false]]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(w.player("p1")?.micBank).toBe(bank - 3);
    expect(w.player("p1")?.onRoomMic).toBe(true);

    await vi.advanceTimersByTimeAsync((bank - 3) * 1000);
    expect(w.player("p1")?.micBank).toBe(0);
    expect(w.player("p1")?.onRoomMic).toBe(false);
    expect(calls.at(-1)).toEqual(["p1", true]);
    mic.dispose();
  });

  it("releasing early stops the drain", async () => {
    const w = new World("r");
    w.addPlayer("p1", "A", "x");
    w.awardPoints("p1", 5, "r");
    const bank = 5 * SECONDS_PER_POINT; // 10 seconds
    const mic = new MicController(w, { setDemonHearsPlayer: async () => {} }, 1000);
    await mic.request("p1", true);
    await vi.advanceTimersByTimeAsync(2000);
    await mic.request("p1", false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.player("p1")?.micBank).toBe(bank - 2);
    expect(w.player("p1")?.onRoomMic).toBe(false);
    mic.dispose();
  });
});
