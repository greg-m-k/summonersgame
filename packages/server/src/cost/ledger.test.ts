import { DEFAULT_PRICES } from "@summoners/shared";
import { describe, expect, it } from "vitest";
import { CostLedger } from "./ledger.ts";

const now = 1_700_000_000_000;

describe("CostLedger", () => {
  it("prices Claude tokens by model with the cached split", () => {
    const l = new CostLedger("r");
    const usd = l.record({
      kind: "llm",
      service: "demon",
      model: "claude-opus-5-5",
      playerId: "ada",
      ts: now,
      inputTokens: 1_000_000,
      cachedTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 100_000,
      calls: 1,
    });
    const p = DEFAULT_PRICES.claude["claude-opus-5-5"]!;
    expect(usd).toBeCloseTo(p.input + p.cachedInput + p.output / 10, 6);
    expect(l.summary().byPlayer.ada?.usd).toBeCloseTo(usd, 6);
    expect(l.summary().byService.demon.units.calls).toBe(1);
  });

  it("prices audio, characters and pictures, and splits shared game-master rounds", () => {
    const l = new CostLedger("r");
    l.record({ kind: "stt", playerId: "ada", ts: now, seconds: 60 });
    l.record({ kind: "tts", playerId: "ada", ts: now, chars: 20_000 });
    l.record({ kind: "image", playerId: "bo", ts: now, images: 2 });
    const gm = l.record({
      kind: "llm",
      service: "gm",
      model: "claude-opus-5-5",
      playerId: null,
      ts: now,
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
      calls: 2,
    });
    l.attribute(["ada", "bo"], gm, "gm");
    const s = l.summary();
    expect(s.byService.stt.usd).toBeCloseTo(DEFAULT_PRICES.sttPerMinute, 6);
    expect(s.byService.tts.usd).toBeCloseTo(DEFAULT_PRICES.ttsPerChar * 20_000, 6);
    expect(s.byService.image.usd).toBeCloseTo(DEFAULT_PRICES.imageEach * 2, 6);
    expect(s.byService.gm.usd).toBeCloseTo(DEFAULT_PRICES.claude["claude-opus-5-5"]!.output, 6);
    expect(s.byPlayer.ada?.byService.gm).toBeCloseTo(gm / 2, 6);
    expect(s.byPlayer.bo?.byService.gm).toBeCloseTo(gm / 2, 6);
    expect(s.totalUsd).toBeCloseTo(s.byService.stt.usd + s.byService.tts.usd + s.byService.image.usd + s.byService.gm.usd, 6);
  });

  it("reports a budget as reached once spend crosses it", () => {
    const l = new CostLedger("r", DEFAULT_PRICES, 0.01);
    expect(l.overBudget).toBe(false);
    l.record({ kind: "image", playerId: null, ts: now, images: 4 });
    expect(l.overBudget).toBe(true);
    expect(l.summary().budgetUsd).toBe(0.01);
  });

  it("pace is dollars per hour over the recent window", () => {
    const l = new CostLedger("r");
    const start = l.since;
    l.record({ kind: "image", playerId: null, ts: start + 30_000, images: 1 });
    // 30 s old room, $0.003 spent: pace = 0.003 * 3600 / 30
    expect(l.pace(start + 30_000)).toBeCloseTo((DEFAULT_PRICES.imageEach * 3_600_000) / 30_000, 6);
  });
});
