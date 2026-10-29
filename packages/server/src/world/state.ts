import { randomUUID } from "node:crypto";
import {
  AGGRO_RADIUS,
  ATTACK_COOLDOWN_S,
  HEART_HP,
  HEART_RADIUS,
  HIT_FRACTION,
  LEVEL_UP_MIC_SECONDS,
  MAX_ENTITIES,
  SECONDS_PER_POINT,
  SPAWN_RADIUS,
  TEAM_IDS,
  TEAM_INFO,
  XP_PER_POINT,
  type TeamId,
  applyEvent,
  emptyWorld,
  heartId,
  heartOwner,
  levelForXp,
  otherTeam,
  talentBlocker,
  teamOfOwner,
  type EntitySpec,
  type Environment,
  type PlayerState,
  type PositionsPacket,
  type SummonInput,
  type Vec3,
  type WorldEvent,
  type WorldState,
} from "@summoners/shared";

export type Listener = (ev: WorldEvent) => void;

/** One point per this much damage to the enemy heart (a 1200 hp heart is worth about 5). */
const HEART_DAMAGE_PER_POINT = 250;
/** Regrowth: fraction of max hp healed per second when nothing is in reach. */
const REGROWTH_PER_S = 0.03;
/** Each kill makes the killer this much stronger. */
const VETERAN_GAIN = 0.1;

export interface WorldHooks {
  /** A heart fell. The room decides what the reveal says and when the next match starts. */
  onHeartDown?: (winner: TeamId) => void;
}

/**
 * Authoritative world for one room. Every change goes through an event so clients can mirror it.
 * Two teams, a heart each; creatures march on the enemy heart and fight what they meet on the tick.
 * Players level up across matches and spend talent points that shape everything they summon.
 */
export class World {
  state: WorldState;
  hooks: WorldHooks = {};
  private listeners = new Set<Listener>();
  private cooldownUntil = new Map<string, number>();
  private heartDamage = new Map<string, number>();
  private healAcc = new Map<string, number>();
  private readonly heartHp: number;

  constructor(
    room: string,
    private now: () => number = () => Date.now(),
    opts: { heartHp?: number } = {},
  ) {
    this.heartHp = opts.heartHp ?? HEART_HP;
    this.state = emptyWorld(room);
    this.startMatch(1);
  }

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: WorldEvent): void {
    this.state = applyEvent(this.state, ev);
    for (const l of this.listeners) l(ev);
  }

  player(identity: string): PlayerState | undefined {
    return this.state.players[identity];
  }

  entity(id: string): EntitySpec | undefined {
    return this.state.entities[id];
  }

  teamOf(ownerId: string): TeamId | null {
    return teamOfOwner(this.state, ownerId);
  }

  talentsOf(ownerId: string): Set<string> {
    return new Set(this.state.players[ownerId]?.talents ?? []);
  }

  teamCounts(): Record<TeamId, number> {
    const counts: Record<TeamId, number> = { ash: 0, tide: 0 };
    for (const p of Object.values(this.state.players)) counts[p.team]++;
    return counts;
  }

  // ---- players ------------------------------------------------------------------------------------

  /** New players go to the smaller team, Ash first on a tie. */
  addPlayer(identity: string, name: string, persona: string): PlayerState {
    const existing = this.state.players[identity];
    if (existing) return existing;
    const counts = this.teamCounts();
    const team: TeamId = counts.tide < counts.ash ? "tide" : "ash";
    const player: PlayerState = {
      identity,
      name,
      persona,
      demonIdentity: null,
      team,
      score: 0,
      xp: 0,
      level: 1,
      talentPoints: 0,
      talents: [],
      micBank: 0,
      onRoomMic: false,
      zoneIndex: TEAM_IDS.indexOf(team),
    };
    this.emit({ type: "player_joined", player });
    return player;
  }

  removePlayer(identity: string): void {
    if (this.state.players[identity]) this.emit({ type: "player_left", playerId: identity });
  }

  setDemon(identity: string, demonIdentity: string | null): void {
    const p = this.state.players[identity];
    if (p) this.emit({ type: "player_updated", player: { ...p, demonIdentity } });
  }

  /**
   * Points are the match score and the source of XP. Each point also pays a little mic time (more
   * with Silver Tongue); each level reached pays a talent point and a chunk of mic time.
   */
  awardPoints(playerId: string, points: number, reason: string): PlayerState | null {
    const p = this.state.players[playerId];
    if (!p) return null;
    const pts = Math.max(1, Math.min(10, Math.round(points)));
    const perPoint = SECONDS_PER_POINT + (p.talents.includes("silver_tongue") ? 2 : 0);
    const xp = p.xp + pts * XP_PER_POINT;
    this.emit({
      type: "points",
      playerId,
      points: pts,
      reason,
      score: p.score + pts,
      micBank: p.micBank + pts * perPoint,
      xp,
    });
    const reached = levelForXp(xp);
    for (let level = p.level + 1; level <= reached; level++) {
      const cur = this.state.players[playerId]!;
      this.emit({
        type: "level_up",
        playerId,
        level,
        talentPoints: cur.talentPoints + 1,
        micBank: cur.micBank + LEVEL_UP_MIC_SECONDS,
      });
    }
    return this.state.players[playerId]!;
  }

  /** Mic seconds without points (bribes). */
  addMicSeconds(playerId: string, seconds: number): PlayerState | null {
    const p = this.state.players[playerId];
    if (!p) return null;
    this.emit({ type: "mic_time", playerId, on: p.onRoomMic, micBank: p.micBank + Math.max(0, seconds) });
    return this.state.players[playerId]!;
  }

  /** Spend a talent point. Returns the reason it was refused, or null when taken. */
  chooseTalent(playerId: string, talentId: string): string | null {
    const p = this.state.players[playerId];
    if (!p) return "unknown player";
    const why = talentBlocker(talentId, p.talents, p.talentPoints);
    if (why) return why;
    this.emit({ type: "talent", playerId, talentId, talents: [...p.talents, talentId], talentPoints: p.talentPoints - 1 });
    return null;
  }

  // ---- the match ----------------------------------------------------------------------------------

  startMatch(number = this.state.match.number + 1): void {
    const counts = this.teamCounts();
    const hearts = TEAM_IDS.map((team) => this.makeHeart(team, counts));
    this.cooldownUntil.clear();
    this.heartDamage.clear();
    this.healAcc.clear();
    this.emit({
      type: "match_started",
      match: { number, phase: "live", startedAt: this.now(), endedAt: null, winner: null },
      hearts,
    });
  }

  private makeHeart(team: TeamId, counts: Record<TeamId, number>): EntitySpec {
    const outnumbered = counts[team] > 0 && counts[otherTeam(team)] > counts[team];
    const hp = Math.round(this.heartHp * (outnumbered ? 1.5 : 1));
    const info = TEAM_INFO[team];
    return {
      id: heartId(team),
      ownerId: heartOwner(team),
      label: `Heart of ${info.name}`,
      imagePrompt:
        team === "ash"
          ? "a colossal anatomical heart carved from molten amber and black iron, veins of fire, floating, dramatic orange rim light"
          : "a colossal anatomical heart carved from clear glacial ice, frost veins, floating, dramatic cyan rim light",
      size: 4,
      hp,
      maxHp: hp,
      attack: 0,
      speed: 0,
      fx: "sparkles",
      idleAnim: "pulse",
      moveStyle: "walk",
      placeholderColor: info.color,
      imageUrl: null,
      position: { x: round(Math.cos(info.angle) * HEART_RADIUS), y: 0, z: round(Math.sin(info.angle) * HEART_RADIUS) },
      target: null,
      targetEntityId: null,
      bornAt: this.now(),
      heart: true,
      lastHitBy: null,
    };
  }

  /** Freeze the arena, pay the winners, reveal the bribes. */
  endMatch(winner: TeamId | null, bribes: Record<string, string[]>): void {
    if (this.state.match.phase === "over") return;
    if (winner) {
      for (const p of Object.values(this.state.players)) {
        if (p.team === winner) this.awardPoints(p.identity, 8, "winning the match");
      }
    }
    const scores: Record<string, number> = {};
    for (const p of Object.values(this.state.players)) scores[p.identity] = p.score;
    this.emit({
      type: "match_over",
      match: { ...this.state.match, phase: "over", endedAt: this.now(), winner },
      winner,
      scores,
      bribes,
    });
  }

  get live(): boolean {
    return this.state.match.phase === "live";
  }

  // ---- entities -----------------------------------------------------------------------------------

  /** Summon with the owner's talents baked in; Echo brings a smaller copy along. */
  summon(input: SummonInput): EntitySpec {
    const talents = this.talentsOf(input.ownerId);
    const boosted: SummonInput = {
      ...input,
      attack: Math.round(input.attack * (talents.has("sharp_teeth") ? 1.2 : 1)),
      hp: Math.round(input.hp * (talents.has("thick_hide") ? 1.25 : 1)),
      speed: round(input.speed * (talents.has("haste") ? 1.3 : 1)),
    };
    const entity = this.spawn(boosted);
    if (talents.has("echo")) {
      this.spawn({
        ...boosted,
        label: `${boosted.label} (echo)`.slice(0, 40),
        hp: Math.max(1, Math.round(boosted.hp * 0.4)),
        attack: Math.round(boosted.attack * 0.4),
        size: Math.max(0.3, round(boosted.size * 0.6)),
      });
    }
    return entity;
  }

  private spawn(input: SummonInput): EntitySpec {
    const owner = this.state.players[input.ownerId];
    const team = owner?.team ?? "ash";
    const creatures = Object.values(this.state.entities).filter((e) => !e.heart);
    if (creatures.length >= MAX_ENTITIES) {
      const oldest = creatures.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
      this.destroy(oldest.id, "faded from the dream");
    }
    const entity: EntitySpec = {
      ...input,
      id: `e-${randomUUID().slice(0, 6)}`,
      imageUrl: null,
      maxHp: input.hp,
      position: spawnPosition(team, creatures.length),
      target: null,
      targetEntityId: null,
      bornAt: this.now(),
      heart: false,
      lastHitBy: null,
      kills: 0,
      spared: false,
    };
    this.emit({ type: "summon", entity });
    return entity;
  }

  /**
   * One strike. `auto` marks the combat engine's own swings; the game master's ordered strikes are
   * not auto and may hit anything, teammates included. Talents of both owners apply.
   */
  attack(
    attackerId: string,
    targetId: string,
    damage: number,
    flavor: string,
    auto = false,
  ): { targetHp: number; destroyed: boolean } | null {
    const attacker = this.state.entities[attackerId];
    const target = this.state.entities[targetId];
    if (!attacker || !target || attackerId === targetId) return null;
    const mine = this.talentsOf(attacker.ownerId);
    const theirs = this.talentsOf(target.ownerId);
    let dmg = Math.max(0, Math.round(damage));
    if (mine.has("bloodlust") && attacker.hp < attacker.maxHp / 2) dmg = Math.round(dmg * 1.3);
    if (mine.has("overkill") && target.heart) dmg = Math.round(dmg * 1.6);
    let targetHp = Math.max(0, target.hp - dmg);
    let spared = false;
    if (targetHp === 0 && !target.heart && !target.spared && theirs.has("second_wind")) {
      targetHp = 1;
      spared = true;
    }
    this.emit({ type: "attack", attackerId, targetId, damage: dmg, targetHp, flavor, auto });
    if (spared) {
      this.emit({ type: "transform", entity: { ...this.state.entities[targetId]!, spared: true }, description: "refuses to die, this once" });
    }
    this.creditHeartDamage(attacker, target, dmg);
    if (targetHp === 0) {
      this.destroy(targetId, `destroyed by ${attacker.label}`);
      this.creditKill(attacker, target);
      this.veteran(attackerId);
      return { targetHp, destroyed: true };
    }
    return { targetHp, destroyed: false };
  }

  /** Destroy anything; a heart going down ends the match for the other team. */
  destroy(entityId: string, cause: string): boolean {
    const e = this.state.entities[entityId];
    if (!e) return false;
    this.emit({ type: "destroy", entityId, cause });
    this.cooldownUntil.delete(entityId);
    this.healAcc.delete(entityId);
    if (e.heart) {
      const team = this.teamOf(e.ownerId);
      if (team) this.hooks.onHeartDown?.(otherTeam(team));
    }
    return true;
  }

  private creditHeartDamage(attacker: EntitySpec, target: EntitySpec, dmg: number): void {
    if (!target.heart || !this.state.players[attacker.ownerId]) return;
    const at = this.teamOf(attacker.ownerId);
    const tt = this.teamOf(target.ownerId);
    if (!at || !tt || at === tt) return;
    const total = (this.heartDamage.get(attacker.ownerId) ?? 0) + dmg;
    const points = Math.floor(total / HEART_DAMAGE_PER_POINT);
    this.heartDamage.set(attacker.ownerId, total - points * HEART_DAMAGE_PER_POINT);
    if (points > 0) this.awardPoints(attacker.ownerId, points, `wounding the ${target.label}`);
  }

  private creditKill(attacker: EntitySpec, victim: EntitySpec): void {
    if (victim.heart || !this.state.players[attacker.ownerId]) return;
    const at = this.teamOf(attacker.ownerId);
    const vt = this.teamOf(victim.ownerId);
    if (!at || !vt || at === vt) return;
    this.awardPoints(attacker.ownerId, 2 + (victim.size > attacker.size ? 1 : 0), `killing ${victim.label}`);
  }

  /** A kill makes the killer tougher: more attack, more max hp, and the hp to go with it. */
  private veteran(attackerId: string): void {
    const a = this.state.entities[attackerId];
    if (!a || a.heart) return;
    const kills = (a.kills ?? 0) + 1;
    const maxHp = Math.round(a.maxHp * (1 + VETERAN_GAIN));
    const entity: EntitySpec = {
      ...a,
      kills,
      attack: Math.round(a.attack * (1 + VETERAN_GAIN)),
      maxHp,
      hp: Math.min(maxHp, a.hp + (maxHp - a.maxHp)),
    };
    this.emit({ type: "transform", entity, description: `grows stronger (${kills} kill${kills === 1 ? "" : "s"})` });
  }

  transform(entityId: string, patch: Partial<Omit<SummonInput, "ownerId">>, description: string): EntitySpec | null {
    const e = this.state.entities[entityId];
    if (!e) return null;
    const next: EntitySpec = { ...e, ...patch };
    if (patch.hp !== undefined) next.maxHp = Math.max(next.maxHp, patch.hp);
    if (patch.imagePrompt !== undefined && patch.imagePrompt !== e.imagePrompt) next.imageUrl = null;
    this.emit({ type: "transform", entity: next, description });
    return next;
  }

  warp(patch: Partial<Environment>, description: string): Environment {
    const environment = { ...this.state.environment, ...patch };
    this.emit({ type: "warp_world", environment, description });
    return environment;
  }

  narrate(text: string): void {
    this.emit({ type: "narrate", text });
  }

  setEntityImage(entityId: string, url: string): void {
    if (this.state.entities[entityId]) this.emit({ type: "entity_image", entityId, url });
  }

  setRoomMic(playerId: string, on: boolean): PlayerState | null {
    const p = this.state.players[playerId];
    if (!p) return null;
    this.emit({ type: "mic_time", playerId, on, micBank: p.micBank });
    return this.state.players[playerId]!;
  }

  /** Burn seconds off a player's bank while they hold the room mic. Returns the remaining bank. */
  drainMic(playerId: string, seconds: number): number {
    const p = this.state.players[playerId];
    if (!p) return 0;
    const micBank = Math.max(0, p.micBank - seconds);
    this.emit({ type: "mic_time", playerId, on: p.onRoomMic, micBank });
    return micBank;
  }

  // ---- the combat engine --------------------------------------------------------------------------

  /**
   * Advance the dream by dt seconds: every creature keeps its target (or picks the nearest enemy in
   * reach, else the enemy heart), walks toward it, swings when close and off cooldown, and heals when
   * its owner has Regrowth and nothing is in reach. Returns a positions packet when something moved.
   * Frozen while the result screen is up.
   */
  step(dt: number): PositionsPacket | null {
    if (!this.live) return null;
    const now = this.now();
    const items: PositionsPacket["items"] = [];

    const entities = { ...this.state.entities };
    for (const e of Object.values(entities)) {
      if (e.heart) continue;
      let target = e.targetEntityId ? entities[e.targetEntityId] : undefined;
      if (!target) {
        target = this.pickTarget(e, entities);
        entities[e.id] = { ...e, targetEntityId: target?.id ?? null };
        if (!target) continue;
      }
      const cur = entities[e.id]!;
      const dx = target.position.x - cur.position.x;
      const dz = target.position.z - cur.position.z;
      const dist = Math.hypot(dx, dz);
      const stop = reach(cur, target);
      if (dist <= stop || cur.speed <= 0) continue;
      const stepLen = cur.moveStyle === "teleport" ? dist - stop : Math.min(cur.speed * dt, dist - stop);
      const position: Vec3 = {
        x: cur.position.x + (dx / dist) * stepLen,
        y: 0,
        z: cur.position.z + (dz / dist) * stepLen,
      };
      entities[cur.id] = { ...cur, position };
      items.push([cur.id, round(position.x), 0, round(position.z)]);
    }
    this.state = { ...this.state, entities, tick: this.state.tick + 1 };

    for (const e of Object.values(this.state.entities)) {
      if (!this.live) break;
      if (e.heart) continue;
      const target = e.targetEntityId ? this.state.entities[e.targetEntityId] : undefined;
      const dist = target ? Math.hypot(target.position.x - e.position.x, target.position.z - e.position.z) : Infinity;
      const inReach = target !== undefined && dist <= reach(e, target) + 0.05;
      if (!inReach) {
        this.regrow(e, dt);
        continue;
      }
      if (e.attack <= 0 || (this.cooldownUntil.get(e.id) ?? 0) > now) continue;
      this.cooldownUntil.set(e.id, now + ATTACK_COOLDOWN_S * 1000 * (0.8 + Math.random() * 0.4));
      const dmg = Math.max(1, Math.round(e.attack * HIT_FRACTION * (0.75 + Math.random() * 0.5)));
      this.attack(e.id, target!.id, dmg, "", true);
    }

    return items.length ? { type: "positions", at: this.now(), items } : null;
  }

  /** Regrowth heals out of combat, one quiet event per whole hit point. */
  private regrow(e: EntitySpec, dt: number): void {
    if (e.hp >= e.maxHp || !this.talentsOf(e.ownerId).has("regrowth")) return;
    const acc = (this.healAcc.get(e.id) ?? 0) + e.maxHp * REGROWTH_PER_S * dt;
    const whole = Math.floor(acc);
    this.healAcc.set(e.id, acc - whole);
    if (whole > 0) this.emit({ type: "heal", entityId: e.id, hp: Math.min(e.maxHp, e.hp + whole) });
  }

  /** Nearest enemy creature within aggro range, else the enemy heart. */
  private pickTarget(e: EntitySpec, entities: WorldState["entities"]): EntitySpec | undefined {
    const team = this.teamOf(e.ownerId);
    if (!team) return undefined;
    let best: EntitySpec | undefined;
    let bestDist = AGGRO_RADIUS;
    for (const other of Object.values(entities)) {
      if (other.id === e.id || other.heart || other.hp <= 0) continue;
      if (this.teamOf(other.ownerId) === team) continue;
      const d = Math.hypot(other.position.x - e.position.x, other.position.z - e.position.z);
      if (d < bestDist) {
        best = other;
        bestDist = d;
      }
    }
    return best ?? entities[heartId(otherTeam(team))];
  }

  snapshot(): WorldState {
    return this.state;
  }

  /** Compact text the game master reads each round. */
  summaryForGM(): string {
    const teams = TEAM_IDS.map((team) => {
      const heart = this.state.entities[heartId(team)];
      const members = Object.values(this.state.players)
        .filter((p) => p.team === team)
        .map((p) => p.name)
        .join(", ");
      return `- ${TEAM_INFO[team].name}: ${members || "nobody"}; heart hp ${heart ? `${heart.hp}/${heart.maxHp}` : "fallen"}`;
    }).join("\n");
    const players = Object.values(this.state.players)
      .map(
        (p) =>
          `- ${p.identity} "${p.name}" team ${TEAM_INFO[p.team].name}, level ${p.level}, score ${p.score}, mic bank ${Math.round(p.micBank)}s${p.talents.length ? `, talents ${p.talents.join("/")}` : ""}`,
      )
      .join("\n");
    const entities = Object.values(this.state.entities)
      .filter((e) => !e.heart)
      .sort((a, b) => a.bornAt - b.bornAt)
      .map((e) => {
        const owner = this.state.players[e.ownerId]?.name ?? e.ownerId;
        const team = this.teamOf(e.ownerId);
        const tgt = e.targetEntityId ? `, fighting ${this.state.entities[e.targetEntityId]?.label ?? e.targetEntityId}` : "";
        const stars = e.kills ? `, ${e.kills} kill${e.kills === 1 ? "" : "s"}` : "";
        return `- ${e.id} "${e.label}" owner ${owner}${team ? ` [${TEAM_INFO[team].name}]` : ""}, hp ${e.hp}/${e.maxHp}, atk ${e.attack}, size ${e.size}, at (${round(e.position.x)}, ${round(e.position.z)})${tgt}${stars}`;
      })
      .join("\n");
    const env = this.state.environment;
    const m = this.state.match;
    return `Match ${m.number} (${m.phase}).\nTeams:\n${teams}\n\nPlayers:\n${players || "- none"}\n\nCreatures (${Object.values(this.state.entities).filter((e) => !e.heart).length}):\n${entities || "- none"}\n\nEnvironment: mood "${env.mood}", gravity ${env.gravity}, sky ${env.skyTop}/${env.skyBottom}`;
  }
}

const reach = (a: EntitySpec, b: EntitySpec): number => (a.size + b.size) * 0.5 + 0.4;

/** Somewhere on the team's half, between the centre and its heart. */
function spawnPosition(team: TeamId, count: number): Vec3 {
  const base = TEAM_INFO[team].angle;
  const angle = base + (Math.random() - 0.5) * ((Math.PI * 2) / 3);
  const radius = SPAWN_RADIUS * (0.45 + 0.5 * Math.random()) + Math.min(count, 10) * 0.1;
  return { x: round(Math.cos(angle) * radius), y: 0, z: round(Math.sin(angle) * radius) };
}

const round = (n: number): number => Math.round(n * 100) / 100;
