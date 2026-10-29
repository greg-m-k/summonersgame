import type { World } from "./world/state.ts";

export interface MicEffects {
  /** Make the player's demon hear (or stop hearing) the player's mic. */
  setDemonHearsPlayer(playerId: string, hears: boolean): Promise<void>;
}

export type MicResult = { ok: true } | { ok: false; reason: string };

/** Mic-time bank: while a player holds the room mic, humans hear them, their demon does not, and the bank drains. */
export class MicController {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private world: World,
    private effects: MicEffects,
    private intervalMs = 1000,
  ) {}

  async request(playerId: string, on: boolean): Promise<MicResult> {
    const p = this.world.player(playerId);
    if (!p) return { ok: false, reason: "unknown player" };
    if (!on) {
      await this.stop(playerId);
      return { ok: true };
    }
    if (p.onRoomMic) return { ok: true };
    if (p.micBank <= 0) return { ok: false, reason: "no mic time" };
    this.world.setRoomMic(playerId, true);
    await this.effects.setDemonHearsPlayer(playerId, false);
    this.timers.set(
      playerId,
      setInterval(() => void this.tick(playerId), this.intervalMs),
    );
    return { ok: true };
  }

  private async tick(playerId: string): Promise<void> {
    const remaining = this.world.drainMic(playerId, this.intervalMs / 1000);
    if (remaining <= 0) await this.stop(playerId);
  }

  private async stop(playerId: string): Promise<void> {
    const t = this.timers.get(playerId);
    if (t) clearInterval(t);
    this.timers.delete(playerId);
    const p = this.world.player(playerId);
    if (p?.onRoomMic) this.world.setRoomMic(playerId, false);
    if (p) await this.effects.setDemonHearsPlayer(playerId, true);
  }

  async playerLeft(playerId: string): Promise<void> {
    const t = this.timers.get(playerId);
    if (t) clearInterval(t);
    this.timers.delete(playerId);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}
