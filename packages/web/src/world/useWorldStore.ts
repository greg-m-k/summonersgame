import { create } from "zustand";
import {
  type EntitySpec,
  type PositionsPacket,
  TALENT_BY_ID,
  TEAM_INFO,
  type WorldEvent,
  type WorldState,
  applyEvent,
  emptyWorld,
} from "@summoners/shared";

export interface FeedLine {
  id: number;
  kind: WorldEvent["type"];
  text: string;
  at: number;
}

export interface Ghost {
  entity: EntitySpec;
  diedAt: number;
}

type MatchOver = Extract<WorldEvent, { type: "match_over" }>;

interface WorldStore {
  world: WorldState;
  positions: Record<string, [number, number, number]>;
  hits: Record<string, number>;
  ghosts: Ghost[];
  feed: FeedLine[];
  /** The last result screen's data (winner, scores, every bribe taken). */
  lastMatchOver: MatchOver | null;
  apply: (ev: WorldEvent) => void;
  setSnapshot: (s: WorldState) => void;
  setPositions: (p: PositionsPacket) => void;
  pruneGhosts: (olderThan: number) => void;
}

let feedId = 0;
const MAX_FEED = 40;

const quarter = (hp: number, max: number): number => Math.ceil((hp / Math.max(1, max)) * 4);

/** Feed text for an event, or null for events the feed should stay quiet about. `world` is the state before the event. */
function describe(ev: WorldEvent, world: WorldState): string | null {
  const name = (id: string) => world.players[id]?.name ?? id;
  const label = (id: string) => world.entities[id]?.label ?? "something";
  switch (ev.type) {
    case "summon":
      return `${name(ev.entity.ownerId)} summons ${ev.entity.label}`;
    case "attack": {
      if (!ev.auto) return `${label(ev.attackerId)} hits ${label(ev.targetId)} for ${ev.damage}: ${ev.flavor}`;
      // The engine swings every second or so; only heart wounds that cross a quarter make the feed.
      const t = world.entities[ev.targetId];
      if (!t?.heart || quarter(t.hp, t.maxHp) === quarter(ev.targetHp, t.maxHp)) return null;
      return `${label(ev.attackerId)} wounds the ${t.label} (${ev.targetHp} hp left)`;
    }
    case "destroy":
      return `${label(ev.entityId)} is gone (${ev.cause})`;
    case "transform":
      return `${ev.entity.label}: ${ev.description}`;
    case "warp_world":
      return `The dream shifts: ${ev.description}`;
    case "narrate":
      return ev.text;
    case "points":
      return `+${ev.points} ${name(ev.playerId)}: ${ev.reason}`;
    case "player_joined":
      return `${ev.player.name} enters with ${ev.player.persona} for team ${TEAM_INFO[ev.player.team].name}`;
    case "player_left":
      return `${name(ev.playerId)} fades out`;
    case "level_up":
      return `${name(ev.playerId)} reaches level ${ev.level}`;
    case "talent":
      return `${name(ev.playerId)} takes ${TALENT_BY_ID[ev.talentId]?.name ?? ev.talentId}`;
    case "match_started":
      return `Match ${ev.match.number}: Ash versus Tide. March on the enemy heart.`;
    case "match_over":
      return ev.winner ? `Team ${TEAM_INFO[ev.winner].name} wins match ${ev.match.number}.` : `Match ${ev.match.number} ends with no winner.`;
    default:
      return null;
  }
}

export const useWorldStore = create<WorldStore>((set) => ({
  world: emptyWorld(""),
  positions: {},
  hits: {},
  ghosts: [],
  feed: [],
  lastMatchOver: null,

  apply: (ev) =>
    set((s) => {
      const text = describe(ev, s.world);
      const feed = text ? [...s.feed, { id: ++feedId, kind: ev.type, text, at: Date.now() }].slice(-MAX_FEED) : s.feed;
      const next: Partial<WorldStore> = { world: applyEvent(s.world, ev), feed };
      if (ev.type === "attack") next.hits = { ...s.hits, [ev.targetId]: Date.now() };
      if (ev.type === "destroy") {
        const e = s.world.entities[ev.entityId];
        if (e) next.ghosts = [...s.ghosts, { entity: e, diedAt: Date.now() }];
      }
      if (ev.type === "summon") {
        next.positions = { ...s.positions, [ev.entity.id]: [ev.entity.position.x, 0, ev.entity.position.z] };
      }
      if (ev.type === "match_started") {
        const positions: WorldStore["positions"] = {};
        for (const h of ev.hearts) positions[h.id] = [h.position.x, 0, h.position.z];
        next.positions = positions;
        next.hits = {};
        next.ghosts = [];
      }
      if (ev.type === "match_over") next.lastMatchOver = ev;
      return next;
    }),

  setSnapshot: (world) =>
    set((s) => {
      const positions = { ...s.positions };
      for (const e of Object.values(world.entities)) {
        positions[e.id] ??= [e.position.x, 0, e.position.z];
      }
      return { world, positions };
    }),

  setPositions: (p) =>
    set((s) => {
      const positions = { ...s.positions };
      for (const [id, x, y, z] of p.items) positions[id] = [x, y, z];
      return { positions };
    }),

  pruneGhosts: (olderThan) =>
    set((s) => (s.ghosts.length ? { ghosts: s.ghosts.filter((g) => g.diedAt > olderThan) } : {})),
}));
