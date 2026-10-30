import { randomBytes } from "node:crypto";
import { type DemonMessage, SECONDS_PER_POINT, type SecretMessage, type WorldEvent, isSummon } from "@summoners/shared";
import type { World } from "./world/state.ts";

export interface TemptationHooks {
  toDemon: (playerId: string, msg: DemonMessage) => void;
  toPlayer: (playerId: string, msg: SecretMessage) => void;
}

type Kind = "destroy_own" | "summon_word" | "betray" | "silence" | "mic";

interface Temptation {
  id: string;
  playerId: string;
  kind: Kind;
  text: string;
  /** Points paid on success (mic seconds = points * SECONDS_PER_POINT). */
  reward: number;
  offeredAt: number;
  expiresAt: number;
  status: "open" | "done" | "failed";
  payload: { entityId?: string; word?: string; teammateId?: string; targetId?: string };
}

const WORDS = ["glass", "bone", "honey", "rust", "moon", "salt", "velvet", "teeth"];
const OFFER_GAP_MS = [40_000, 70_000] as const;
const FIRST_OFFER_AFTER_MS = 25_000;
const EXPIRES_MS = 60_000;
const SILENCE_MS = 30_000;
const MIC_SECONDS = 5;

/**
 * Demons are on nobody's side. Every so often one offers its player a private deal that pays mic
 * seconds: kill your own thing, name your next summon after a word, turn on a teammate, keep quiet,
 * sweet-talk the enemy on the room mic. Checked here from the event stream; revealed at match end.
 */
export class Temptations {
  private open = new Map<string, Temptation>();
  private taken = new Map<string, Temptation[]>();
  private lastOffer = new Map<string, number>();
  private nextGap = new Map<string, number>();
  private lastSpoke = new Map<string, number>();
  private micOnAt = new Map<string, number>();
  private micHeld = new Map<string, number>();
  private lastHitTeam = new Map<string, string | null>();

  constructor(
    private world: World,
    private hooks: TemptationHooks,
    private now: () => number = () => Date.now(),
  ) {}

  /** Everything accepted this match, for the reveal. */
  bribesTaken(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [player, list] of this.taken) out[player] = list.map((t) => t.text);
    return out;
  }

  /** New match: open deals die quietly, the ledger of taken bribes starts over. */
  reset(): void {
    this.open.clear();
    this.taken.clear();
    this.micHeld.clear();
    this.lastHitTeam.clear();
  }

  onTranscript(playerId: string): void {
    const now = this.now();
    this.lastSpoke.set(playerId, now);
    for (const t of this.openFor(playerId)) if (t.kind === "silence") this.settle(t, false);
  }

  onEvent(ev: WorldEvent): void {
    const now = this.now();
    switch (ev.type) {
      case "attack": {
        const attacker = this.world.entity(ev.attackerId);
        const target = this.world.entity(ev.targetId);
        if (target) this.lastHitTeam.set(target.id, attacker ? this.world.teamOf(attacker.ownerId) : null);
        if (!ev.auto && attacker && target) {
          for (const t of this.openFor(attacker.ownerId)) {
            if (t.kind === "betray" && target.ownerId === t.payload.teammateId) this.settle(t, true);
          }
        }
        return;
      }
      case "destroy": {
        const hitBy = this.lastHitTeam.get(ev.entityId);
        this.lastHitTeam.delete(ev.entityId);
        if (ev.cause === "faded from the dream") return;
        for (const t of this.open.values()) {
          if (t.kind !== "destroy_own" || t.payload.entityId !== ev.entityId) continue;
          const ownTeam = this.world.player(t.playerId)?.team ?? null;
          // Counts when nobody from the other side did it: own strike, or the game master unmade it.
          this.settle(t, hitBy === undefined || hitBy === null || hitBy === ownTeam);
        }
        return;
      }
      case "summon": {
        const text = `${ev.entity.label} ${ev.entity.imagePrompt}`.toLowerCase();
        for (const t of this.openFor(ev.entity.ownerId)) {
          if (t.kind === "summon_word" && t.payload.word) this.settle(t, text.includes(t.payload.word));
        }
        return;
      }
      case "mic_time": {
        const wasOn = this.micOnAt.has(ev.playerId);
        if (ev.on && !wasOn) this.micOnAt.set(ev.playerId, now);
        if (!ev.on && wasOn) {
          const held = (now - this.micOnAt.get(ev.playerId)!) / 1000;
          this.micOnAt.delete(ev.playerId);
          this.micHeld.set(ev.playerId, (this.micHeld.get(ev.playerId) ?? 0) + held);
        }
        for (const t of this.openFor(ev.playerId)) {
          if (t.kind !== "mic") continue;
          const since = this.heldSince(ev.playerId, t.offeredAt, now);
          if (since >= MIC_SECONDS) this.settle(t, true);
        }
        return;
      }
      case "player_left":
        for (const t of this.openFor(ev.playerId)) this.open.delete(t.id);
        return;
      default:
        return;
    }
  }

  /** Once a second: expire what is due, offer something new to whoever is ready. */
  tick(): void {
    const now = this.now();
    for (const t of [...this.open.values()]) {
      if (now < t.expiresAt) continue;
      if (t.kind === "silence") this.settle(t, (this.lastSpoke.get(t.playerId) ?? 0) < t.offeredAt);
      else if (t.kind === "mic") this.settle(t, this.heldSince(t.playerId, t.offeredAt, now) >= MIC_SECONDS);
      else this.settle(t, false);
    }
    if (!this.world.live) return;
    for (const p of Object.values(this.world.state.players)) {
      if (!p.demonIdentity || this.openFor(p.identity).length) continue;
      // First offer a short, player-specific while after the match starts, so four demons do not
      // all whisper at the same second.
      const last =
        this.lastOffer.get(p.identity) ?? this.world.state.match.startedAt + FIRST_OFFER_AFTER_MS + this.jitter(p.identity) - this.gap(p.identity);
      if (now - last < this.gap(p.identity)) continue;
      const t = this.pick(p.identity, now);
      this.lastOffer.set(p.identity, now);
      this.nextGap.delete(p.identity);
      if (!t) continue;
      this.micBaseline.set(`${p.identity}:${t.offeredAt}`, this.micHeld.get(p.identity) ?? 0);
      this.open.set(t.id, t);
      const rewardSeconds = t.reward * SECONDS_PER_POINT;
      this.hooks.toDemon(p.identity, { type: "temptation", id: t.id, text: t.text, rewardSeconds, expiresAt: t.expiresAt });
      this.hooks.toPlayer(p.identity, { type: "temptation", id: t.id, text: t.text, rewardSeconds, expiresAt: t.expiresAt });
    }
  }

  private jitter(playerId: string): number {
    let j = this.firstJitter.get(playerId);
    if (j === undefined) {
      j = Math.random() * 20_000;
      this.firstJitter.set(playerId, j);
    }
    return j;
  }
  private firstJitter = new Map<string, number>();

  private gap(playerId: string): number {
    let g = this.nextGap.get(playerId);
    if (g === undefined) {
      g = OFFER_GAP_MS[0] + Math.random() * (OFFER_GAP_MS[1] - OFFER_GAP_MS[0]);
      this.nextGap.set(playerId, g);
    }
    return g;
  }

  /** Seconds on the room mic since the offer: completed holds since then plus the one in progress. */
  private heldSince(playerId: string, since: number, now: number): number {
    const completed = this.micHeld.get(playerId) ?? 0;
    const baseline = this.micBaseline.get(`${playerId}:${since}`) ?? completed;
    this.micBaseline.set(`${playerId}:${since}`, baseline);
    const onAt = this.micOnAt.get(playerId);
    const inProgress = onAt !== undefined ? Math.max(0, now - Math.max(onAt, since)) / 1000 : 0;
    return completed - baseline + inProgress;
  }
  private micBaseline = new Map<string, number>();

  private openFor(playerId: string): Temptation[] {
    return [...this.open.values()].filter((t) => t.playerId === playerId);
  }

  private pick(playerId: string, now: number): Temptation | null {
    const p = this.world.player(playerId);
    if (!p) return null;
    const entities = Object.values(this.world.state.entities);
    const mine = entities.filter((e) => e.ownerId === playerId && isSummon(e));
    const teammates = Object.values(this.world.state.players).filter((o) => o.team === p.team && o.identity !== playerId);
    const theirs = entities.filter((e) => isSummon(e) && teammates.some((o) => o.identity === e.ownerId));
    const options: Array<() => Temptation> = [];
    const base = (kind: Kind, text: string, reward: number, payload: Temptation["payload"], ttl = EXPIRES_MS): Temptation => ({
      id: randomBytes(4).toString("hex"),
      playerId,
      kind,
      text,
      reward,
      offeredAt: now,
      expiresAt: now + ttl,
      status: "open",
      payload,
    });
    if (mine.length) {
      const e = mine[Math.floor(Math.random() * mine.length)]!;
      options.push(() => base("destroy_own", `Kill your own ${e.label}. Say the words. Nobody has to know.`, 6, { entityId: e.id }));
    }
    const word = WORDS[Math.floor(Math.random() * WORDS.length)]!;
    options.push(() => base("summon_word", `Your next summon must have "${word}" in its name.`, 4, { word }));
    if (theirs.length) {
      const e = theirs[Math.floor(Math.random() * theirs.length)]!;
      const mate = this.world.player(e.ownerId)?.name ?? "your teammate";
      options.push(() => base("betray", `Order your creature to attack ${mate}'s ${e.label}. Just once.`, 10, { teammateId: e.ownerId, targetId: e.id }));
    }
    options.push(() => base("silence", "Say nothing for thirty seconds. Not a word to me. I'll pay.", 5, {}, SILENCE_MS));
    if (p.micBank >= MIC_SECONDS) {
      options.push(() => base("mic", "Hold the human mic for five seconds and say something sweet to the enemy.", 5, {}));
    }
    const make = options[Math.floor(Math.random() * options.length)];
    return make ? make() : null;
  }

  private settle(t: Temptation, success: boolean): void {
    if (t.status !== "open") return;
    t.status = success ? "done" : "failed";
    this.open.delete(t.id);
    const rewardSeconds = t.reward * SECONDS_PER_POINT;
    if (success) {
      const list = this.taken.get(t.playerId) ?? [];
      list.push(t);
      this.taken.set(t.playerId, list);
      this.world.awardPoints(t.playerId, t.reward, "a private arrangement");
      this.world.addMicSeconds(t.playerId, rewardSeconds);
    }
    const msg = { type: "temptation_result" as const, id: t.id, text: t.text, success, rewardSeconds };
    this.hooks.toDemon(t.playerId, msg);
    this.hooks.toPlayer(t.playerId, msg);
  }
}
