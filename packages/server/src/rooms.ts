import { randomBytes } from "node:crypto";
import type { ParticipantInfo } from "livekit-server-sdk";
import { ParticipantInfo_Kind } from "@livekit/protocol";
import {
  type DemonMessage,
  MATCH_OVER_MS,
  SERVICES,
  TEAM_INFO,
  TOPIC_COST,
  TOPIC_DEMON,
  TOPIC_SECRET,
  type TeamId,
  type UsageEvent,
  type WorldEvent,
} from "@summoners/shared";
import { CostLedger } from "./cost/ledger.ts";
import { Temptations } from "./temptations.ts";
import { env, prices } from "./env.ts";
import { type GmUsage, GmEngine } from "./gm/engine.ts";
import { ImageService } from "./images/gen.ts";
import {
  agentDispatch,
  broadcast,
  broadcastLossy,
  broadcastReliable,
  micTrackSid,
  mintPlayerToken,
  roomService,
  sendToIdentity,
  setSubscribed,
} from "./livekit.ts";
import { MicController } from "./micTime.ts";
import { type Persona, pickPersona } from "./personas.ts";
import { World } from "./world/state.ts";

const SNAPSHOT_DEBOUNCE_MS = 2000;
const MOVE_TICK_MS = 100;
const ROSTER_POLL_MS = 5000;
const JOIN_GRACE_MS = 20_000;
const LEAVE_GRACE_MS = 15_000;
const EMPTY_ROOM_TTL_MS = 5 * 60_000;
/** How long a dispatched demon gets to register before it is dispatched again. */
const DEMON_GRACE_MS = 15_000;
const MAX_REDISPATCHES = 3;
const COST_BROADCAST_DEBOUNCE_MS = 2000;
const COST_LOG_MS = 60_000;

interface PlayerRecord {
  sessionKey: string;
  joinedAt: number;
  dispatchId: string | null;
  dispatchedAt: number;
  redispatches: number;
  persona: Persona;
  /** When the roster poll first failed to see this player; null while present. */
  missingSince: number | null;
}

/** One live game room: world, game master, mic bank, image pipeline, cost ledger, and LiveKit plumbing. */
export class GameRoom {
  readonly world: World;
  readonly gm: GmEngine;
  readonly mic: MicController;
  readonly images: ImageService;
  readonly cost: CostLedger;
  readonly temptations: Temptations;
  private records = new Map<string, PlayerRecord>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private costTimer: ReturnType<typeof setTimeout> | undefined;
  private matchTimer: ReturnType<typeof setTimeout> | undefined;
  private emptySince: number | null = Date.now();
  private budgetTripped = false;
  private lastLoggedUsd = 0;

  constructor(
    readonly name: string,
    private onEmpty: (room: GameRoom) => void,
  ) {
    this.world = new World(name, undefined, { heartHp: env.HEART_HP });
    this.world.hooks.onHeartDown = (winner) => this.endMatch(winner);
    this.temptations = new Temptations(this.world, {
      toDemon: (playerId, msg) => {
        const demon = this.world.player(playerId)?.demonIdentity;
        if (demon) void sendToIdentity(this.name, demon, TOPIC_DEMON, msg);
      },
      toPlayer: (playerId, msg) => void sendToIdentity(this.name, playerId, TOPIC_SECRET, msg),
    });
    this.cost = new CostLedger(name, prices, env.ROOM_BUDGET_USD);
    this.images = new ImageService((entityId, url) => this.world.setEntityImage(entityId, url), {
      falKey: env.FAL_KEY,
      onUsage: (entity) => this.recordUsage({ kind: "image", images: 1, playerId: entity.ownerId, ts: Date.now() }),
    });
    this.gm = new GmEngine(this.world, { onUsage: (u) => this.recordGm(u) });
    this.mic = new MicController(this.world, {
      setDemonHearsPlayer: (playerId, hears) => this.setDemonHears(playerId, hears),
    });

    this.world.onEvent((ev) => this.onWorldEvent(ev));
    this.timers.push(
      setInterval(() => {
        const packet = this.world.step(MOVE_TICK_MS / 1000);
        if (packet) void broadcastLossy(this.name, packet);
      }, MOVE_TICK_MS),
      setInterval(() => void this.reconcile(), ROSTER_POLL_MS),
      setInterval(() => this.logCost(), COST_LOG_MS),
      setInterval(() => this.temptations.tick(), 1000),
    );
  }

  private onWorldEvent(ev: WorldEvent): void {
    void broadcastReliable(this.name, ev);
    this.temptations.onEvent(ev);
    if (!this.budgetTripped && (ev.type === "summon" || (ev.type === "transform" && ev.entity.imageUrl === null))) {
      this.images.request(ev.entity);
    }
    this.scheduleSnapshot();
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      roomService.updateRoomMetadata(this.name, JSON.stringify(this.world.snapshot())).catch(() => {});
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  async join(name: string): Promise<{ token: string; identity: string; persona: string; sessionKey: string }> {
    await roomService.createRoom({ name: this.name, emptyTimeout: 600, departureTimeout: 60 }).catch(() => {});
    const identity = `${slug(name)}-${randomBytes(2).toString("hex")}`;
    const persona = pickPersona(new Set([...this.records.values()].map((r) => r.persona.name)));
    const sessionKey = randomBytes(12).toString("hex");
    const rec: PlayerRecord = {
      sessionKey,
      joinedAt: Date.now(),
      dispatchId: null,
      dispatchedAt: 0,
      redispatches: 0,
      persona,
      missingSince: null,
    };
    this.records.set(identity, rec);
    this.emptySince = null;
    this.world.addPlayer(identity, name, persona.name);
    const token = await mintPlayerToken(this.name, identity, name);
    await this.dispatchDemon(identity, rec);
    return { token, identity, persona: persona.name, sessionKey };
  }

  private async dispatchDemon(identity: string, rec: PlayerRecord): Promise<void> {
    const p = this.world.player(identity);
    if (!p) return;
    if (rec.dispatchId) await agentDispatch.deleteDispatch(rec.dispatchId, this.name).catch(() => {});
    rec.dispatchId = null;
    rec.dispatchedAt = Date.now();
    try {
      const dispatch = await agentDispatch.createDispatch(this.name, env.DEMON_AGENT_NAME, {
        metadata: JSON.stringify({
          playerIdentity: identity,
          playerName: p.name,
          persona: rec.persona,
          serverUrl: env.GAME_SERVER_URL,
          room: this.name,
        }),
      });
      rec.dispatchId = dispatch.id;
    } catch (err) {
      console.warn(`[room ${this.name}] demon dispatch failed for ${identity}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Dispatch again when a demon never registered (worker not up yet, dispatch dropped) or its job
   * ended (page refresh closes the session, worker restart). Bounded so a broken pipeline does not
   * loop forever.
   */
  private async ensureDemon(identity: string, rec: PlayerRecord, agents: Set<string>, now: number): Promise<void> {
    const p = this.world.player(identity);
    if (!p || now - rec.dispatchedAt < DEMON_GRACE_MS || rec.redispatches >= MAX_REDISPATCHES) return;
    if (p.demonIdentity && agents.has(p.demonIdentity)) return;
    rec.redispatches++;
    console.warn(
      `[room ${this.name}] ${p.persona} ${p.demonIdentity ? "left" : "never arrived"} for ${p.name}; dispatching again (${rec.redispatches}/${MAX_REDISPATCHES})`,
    );
    if (p.demonIdentity) this.world.setDemon(identity, null);
    await this.dispatchDemon(identity, rec);
  }

  verify(identity: string, sessionKey: string): boolean {
    return this.records.get(identity)?.sessionKey === sessionKey;
  }

  registerDemon(
    playerIdentity: string,
    demonIdentity: string,
    status: "online" | "error",
    detail?: string,
    mocks: string[] = [],
  ): boolean {
    const p = this.world.player(playerIdentity);
    if (!p) return false;
    if (status === "error") {
      console.warn(`[room ${this.name}] demon ${p.persona} for ${p.name} failed: ${detail ?? "unknown error"}`);
      this.world.narrate(`${p.persona} fails to manifest for ${p.name}: ${detail ?? "unknown error"}`);
      this.world.setDemon(playerIdentity, null);
      return true;
    }
    this.world.setDemon(playerIdentity, demonIdentity);
    if (mocks.length) {
      this.world.narrate(`${p.persona} manifests for ${p.name} on mock ${mocks.join(", ")} (no API key). Type to it if it cannot hear words.`);
    }
    if (this.budgetTripped) void this.setDemonHears(playerIdentity, false);
    return true;
  }

  transcript(playerIdentity: string, text: string, ts: number): boolean {
    const p = this.world.player(playerIdentity);
    if (!p) return false;
    this.temptations.onTranscript(playerIdentity);
    this.gm.push({ playerId: playerIdentity, name: p.name, text, ts });
    return true;
  }

  // ---- the match ----------------------------------------------------------------------------------

  /** A heart fell: freeze, pay the winners, reveal every bribe, and start again after the result screen. */
  private endMatch(winner: TeamId): void {
    if (!this.world.live) return;
    const bribes = this.temptations.bribesTaken();
    this.world.endMatch(winner, bribes);
    this.gm.setPaused(true);
    const reveal = Object.values(this.world.state.players).map((p) => {
      const b = bribes[p.identity] ?? [];
      return b.length ? `${p.name} took ${b.length} bribe${b.length === 1 ? "" : "s"}: ${b.join(" / ")}` : `${p.name} stayed clean`;
    });
    this.world.narrate(`The Heart of ${TEAM_INFO[winner].name} still beats. ${reveal.join(". ")}.`);
    console.log(`[room ${this.name}] match ${this.world.state.match.number} over: ${TEAM_INFO[winner].name} wins`);
    this.matchTimer = setTimeout(() => {
      this.matchTimer = undefined;
      this.temptations.reset();
      this.world.startMatch();
      if (!this.budgetTripped) this.gm.setPaused(false);
    }, MATCH_OVER_MS);
  }

  // ---- cost -------------------------------------------------------------------------------------

  /** Meter readings from a player's demon (its brain, ears, and voice). */
  usage(playerIdentity: string, events: UsageEvent[]): boolean {
    if (!this.records.has(playerIdentity)) return false;
    for (const ev of events) this.cost.record({ ...ev, playerId: playerIdentity });
    this.afterCost();
    return true;
  }

  private recordUsage(ev: UsageEvent): void {
    this.cost.record(ev);
    this.afterCost();
  }

  /** A game master round is shared: bill it once, then split it across the players who spoke. */
  private recordGm(u: GmUsage): void {
    const usd = this.cost.record({
      kind: "llm",
      service: "gm",
      model: u.model,
      playerId: null,
      ts: Date.now(),
      inputTokens: u.inputTokens,
      cachedTokens: u.cachedTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      outputTokens: u.outputTokens,
      calls: u.calls,
    });
    this.cost.attribute(u.players, usd, "gm");
    this.afterCost();
  }

  private afterCost(): void {
    if (!this.costTimer) {
      this.costTimer = setTimeout(() => {
        this.costTimer = undefined;
        void broadcast(this.name, TOPIC_COST, this.cost.summary());
      }, COST_BROADCAST_DEBOUNCE_MS);
    }
    if (this.cost.overBudget && !this.budgetTripped) void this.tripBudget();
  }

  /** Budget reached: the game master drops everything and every demon stops hearing and speaking. */
  private async tripBudget(): Promise<void> {
    this.budgetTripped = true;
    console.warn(
      `[room ${this.name}] budget of $${env.ROOM_BUDGET_USD} reached ($${this.cost.totalUsd.toFixed(3)}); pausing the game master and every demon`,
    );
    this.gm.setPaused(true);
    this.world.narrate("The dream runs out of money. The demons fall silent and nothing new can be born until the budget grows.");
    for (const identity of this.records.keys()) await this.setDemonHears(identity, false);
  }

  private logCost(): void {
    const total = this.cost.totalUsd;
    if (total <= this.lastLoggedUsd) return;
    const minute = total - this.lastLoggedUsd;
    this.lastLoggedUsd = total;
    const s = this.cost.summary();
    const by = SERVICES.filter((k) => s.byService[k].usd > 0)
      .map((k) => `${k} $${s.byService[k].usd.toFixed(3)}`)
      .join(", ");
    console.log(
      `[cost ${this.name}] total $${total.toFixed(3)}, last minute $${minute.toFixed(3)}, pace $${s.paceUsdPerHour.toFixed(2)}/h (${by})`,
    );
  }

  // ---- audio routing ----------------------------------------------------------------------------

  private async setDemonHears(playerId: string, hears: boolean): Promise<void> {
    if (hears && this.budgetTripped) return; // nothing wakes a demon once the budget is gone
    const p = this.world.player(playerId);
    if (!p?.demonIdentity) return;
    const msg: DemonMessage = { type: "demon_pause", on: !hears };
    await sendToIdentity(this.name, p.demonIdentity, TOPIC_DEMON, msg);
    const sid = await micTrackSid(this.name, playerId);
    if (!sid) return;
    try {
      await setSubscribed(this.name, p.demonIdentity, sid, hears);
    } catch (err) {
      console.warn(`[room ${this.name}] updateSubscriptions failed:`, err instanceof Error ? err.message : err);
    }
  }

  /** Drop players who are no longer in the LiveKit room; tear the room down once it has been empty a while. */
  private async reconcile(): Promise<void> {
    let participants: ParticipantInfo[];
    try {
      participants = await roomService.listParticipants(this.name);
    } catch {
      participants = [];
    }
    const present = new Set(participants.filter((p) => p.kind !== ParticipantInfo_Kind.AGENT).map((p) => p.identity));
    const agents = new Set(participants.filter((p) => p.kind === ParticipantInfo_Kind.AGENT).map((p) => p.identity));
    const now = Date.now();
    for (const [identity, rec] of this.records) {
      if (present.has(identity) || now - rec.joinedAt < JOIN_GRACE_MS) {
        rec.missingSince = null;
        if (present.has(identity)) await this.ensureDemon(identity, rec, agents, now);
        continue;
      }
      // A page refresh drops and rejoins within seconds; only remove after a sustained absence.
      rec.missingSince ??= now;
      if (now - rec.missingSince < LEAVE_GRACE_MS) continue;
      await this.removePlayer(identity, rec);
    }
    if (this.records.size === 0) {
      this.emptySince ??= now;
      if (now - this.emptySince > EMPTY_ROOM_TTL_MS) this.onEmpty(this);
    }
  }

  private async removePlayer(identity: string, rec: PlayerRecord): Promise<void> {
    this.records.delete(identity);
    await this.mic.playerLeft(identity);
    this.world.removePlayer(identity);
    if (rec.dispatchId) await agentDispatch.deleteDispatch(rec.dispatchId, this.name).catch(() => {});
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.costTimer) clearTimeout(this.costTimer);
    if (this.matchTimer) clearTimeout(this.matchTimer);
    this.mic.dispose();
    this.gm.dispose();
    this.logCost();
  }
}

export class RoomRegistry {
  private rooms = new Map<string, GameRoom>();

  get(name: string): GameRoom | undefined {
    return this.rooms.get(name);
  }

  getOrCreate(name: string): GameRoom {
    let r = this.rooms.get(name);
    if (!r) {
      r = new GameRoom(name, (room) => {
        console.log(`[rooms] ${room.name} empty, disposing`);
        room.dispose();
        this.rooms.delete(room.name);
      });
      this.rooms.set(name, r);
      console.log(`[rooms] created ${name}`);
    }
    return r;
  }

  list(): string[] {
    return [...this.rooms.keys()];
  }
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  return s || "player";
}
