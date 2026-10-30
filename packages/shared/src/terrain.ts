import { ARENA_RADIUS, HEART_RADIUS, type Lane, type LaneId, type Obstacle, type ObstacleKind, TEAM_IDS, TEAM_INFO, type TeamId, type Terrain } from "./world.ts";

/**
 * The playing field: three lanes between the hearts, towers guarding each lane, and rocks, pillars,
 * crystals, ruins and pools scattered between the lanes that creatures have to walk around. Built
 * once per match from a seed so the server, every client and every bot agree without shipping
 * geometry; the seed is in the match_started event.
 */

/** Minion waves and towers, here so the client can explain them. */
export const FIRST_WAVE_MS = 20_000;
export const WAVE_INTERVAL_MS = 30_000;
export const MINIONS_PER_LANE = 2;
export const MINION_AGGRO_RADIUS = 3.5;
export const TOWER_RANGE = 5.5;
export const TOWER_HP = 300;
export const TOWER_ATTACK = 40;
export const TOWER_COOLDOWN_S = 1.0;
/** Points for the player whose creature topples a tower. */
export const TOWER_POINTS = 3;
/** Minion kills are worth a point once this many add up. */
export const MINION_KILLS_PER_POINT = 3;

/** Small, fast, deterministic PRNG so every peer can rebuild the same field from the seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const heartX = (team: TeamId): number => Math.cos(TEAM_INFO[team].angle) * HEART_RADIUS;

/** A quadratic curve from the Ash heart to the Tide heart bowing through `via`, sampled into waypoints. */
function laneThrough(id: LaneId, via: { x: number; z: number }, samples: number): Lane {
  const a = { x: heartX("ash"), z: 0 };
  const b = { x: heartX("tide"), z: 0 };
  const points: Lane["points"] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    points.push({
      x: round(u * u * a.x + 2 * u * t * via.x + t * t * b.x),
      z: round(u * u * a.z + 2 * u * t * via.z + t * t * b.z),
    });
  }
  return { id, points };
}

function distToSegment(p: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

export function distToLane(p: { x: number; z: number }, lane: Lane): number {
  let best = Infinity;
  for (let i = 1; i < lane.points.length; i++) best = Math.min(best, distToSegment(p, lane.points[i - 1]!, lane.points[i]!));
  return best;
}

/** Lanes bow out to a side that depends on the seed, so no two matches look the same. */
export function generateTerrain(seed: number): Terrain {
  const rnd = mulberry32(seed);
  const bow = 7 + rnd() * 2.5;
  const lanes: Lane[] = [
    laneThrough("north", { x: (rnd() - 0.5) * 4, z: -bow * 1.9 }, 6),
    laneThrough("mid", { x: 0, z: (rnd() - 0.5) * 1.5 }, 4),
    laneThrough("south", { x: (rnd() - 0.5) * 4, z: bow * 1.9 }, 6),
  ];
  const obstacles: Obstacle[] = [];
  const kinds: ObstacleKind[] = ["rock", "rock", "rock", "pillar", "pillar", "crystal", "crystal", "ruin", "pool", "pool"];
  const want = 12 + Math.floor(rnd() * 4);
  let tries = 0;
  while (obstacles.length < want && tries++ < 400) {
    const kind = kinds[Math.floor(rnd() * kinds.length)]!;
    const r = kind === "pool" ? 1.6 + rnd() * 1.2 : kind === "pillar" ? 0.6 + rnd() * 0.4 : kind === "ruin" ? 1.2 + rnd() * 0.8 : 0.9 + rnd() * 0.9;
    const ang = rnd() * Math.PI * 2;
    const rad = 2.5 + rnd() * (ARENA_RADIUS - 2.5);
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const p = { x, z };
    // Keep the lanes walkable, the hearts clear, and the pieces apart.
    if (lanes.some((l) => distToLane(p, l) < r + 1.4)) continue;
    if (TEAM_IDS.some((t) => Math.hypot(x - heartX(t), z) < r + 4.5)) continue;
    if (obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + r + 3.2)) continue;
    obstacles.push({
      id: `t-${obstacles.length}`,
      kind,
      x: round(x),
      z: round(z),
      r: round(r),
      h: round(kind === "pool" ? 0.05 : kind === "pillar" ? 1.8 + rnd() * 1.4 : kind === "crystal" ? 1.8 + rnd() * 1.6 : kind === "ruin" ? 1.2 + rnd() * 1.2 : 0.8 + r * 0.9),
      rot: round(rnd() * Math.PI * 2),
    });
  }
  return { seed, obstacles, lanes };
}

/** Where a team's tower stands on a lane: a third of the way from its own heart. */
export function towerSpot(lane: Lane, team: TeamId): { x: number; z: number } {
  const pts = team === "ash" ? lane.points : [...lane.points].reverse();
  const i = Math.round((pts.length - 1) * 0.3);
  return pts[i]!;
}

/** Deterministic hash of a room name, so each room's matches draw different fields. */
export function roomSeed(room: string, match: number): number {
  let h = 2166136261;
  for (let i = 0; i < room.length; i++) h = Math.imul(h ^ room.charCodeAt(i), 16777619);
  return ((h >>> 0) + match * 7919) >>> 0;
}

/** Walkable speed factor at a point: pools are waist deep. */
export function groundFactor(terrain: Terrain, x: number, z: number): number {
  for (const o of terrain.obstacles) {
    if (o.kind === "pool" && Math.hypot(o.x - x, o.z - z) < o.r) return 0.5;
  }
  return 1;
}

/** Radius of the padded disc a body of this size must keep clear of a solid obstacle. */
const padFor = (o: Obstacle, bodyRadius: number): number => o.r + bodyRadius * 0.6;

/** Push a point out of every solid obstacle it overlaps. */
function resolve(solid: Obstacle[], x: number, z: number, bodyRadius: number): { x: number; z: number } {
  for (const o of solid) {
    const d = Math.hypot(x - o.x, z - o.z);
    const min = padFor(o, bodyRadius);
    if (d < min) {
      const nx = d > 1e-6 ? (x - o.x) / d : 1;
      const nz = d > 1e-6 ? (z - o.z) / d : 0;
      x = o.x + nx * min;
      z = o.z + nz * min;
    }
  }
  return { x, z };
}

/**
 * One movement step that walks around solid obstacles: head for the goal, and when a rock is in
 * the way slide along its tangent. `side` (+1 or -1) is which way round the caller is already
 * going; keeping it between ticks stops a body dithering left-right in front of a rock. The
 * result reports the side used, or 0 when nothing was in the way. A body is never left inside a
 * rock, before or after the step.
 */
export function stepAround(
  terrain: Terrain,
  from: { x: number; z: number },
  to: { x: number; z: number },
  stepLen: number,
  bodyRadius: number,
  side: -1 | 0 | 1 = 0,
): { x: number; z: number; side: -1 | 0 | 1 } {
  const solid = terrain.obstacles.filter((o) => o.kind !== "pool");
  let { x, z } = resolve(solid, from.x, from.z, bodyRadius);
  let dx = to.x - x;
  let dz = to.z - z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6 || stepLen <= 0) return { x, z, side: 0 };
  dx /= dist;
  dz /= dist;
  // The nearest solid obstacle whose padded disc the next stretch of path would cross.
  let blocker: Obstacle | null = null;
  let blockerAlong = Infinity;
  const look = Math.min(dist, stepLen + 2.5);
  for (const o of solid) {
    const pad = padFor(o, bodyRadius) + 0.15;
    const ox = o.x - x;
    const oz = o.z - z;
    const along = ox * dx + oz * dz;
    if (along < -pad || along > look + pad) continue;
    const side2 = Math.abs(ox * dz - oz * dx);
    if (side2 >= pad) continue;
    // A rock just past the goal (the thing we are walking up to stands beside it) is not in the way.
    if (along - Math.sqrt(pad * pad - side2 * side2) >= dist) continue;
    if (along < blockerAlong) {
      blocker = o;
      blockerAlong = along;
    }
  }
  if (!blocker) {
    const p = resolve(solid, x + dx * stepLen, z + dz * stepLen, bodyRadius);
    return { ...p, side: 0 };
  }
  // Steer in short steps: a tangent step as long as the rock is wide would overshoot into the next one.
  stepLen = Math.min(stepLen, 0.8);
  const pad = padFor(blocker, bodyRadius) + 0.15;
  const ox = blocker.x - x;
  const oz = blocker.z - z;
  const cross = ox * dz - oz * dx;
  // Keep going round the way we already were; otherwise take the side we are already nearer.
  const s: -1 | 1 = side !== 0 ? side : cross > 0 ? -1 : 1;
  const tx = -dz * s;
  const tz = dx * s;
  // Blend from "straight" far away to "tangent" when touching, so paths curve instead of kink.
  const d = Math.hypot(ox, oz);
  const w = Math.max(0, Math.min(1, 1 - (d - pad) / 2.5));
  let mx = dx * (1 - w) + tx * w;
  let mz = dz * (1 - w) + tz * w;
  const ml = Math.hypot(mx, mz) || 1;
  mx /= ml;
  mz /= ml;
  const p = resolve(solid, x + mx * stepLen, z + mz * stepLen, bodyRadius);
  return { ...p, side: s };
}

const round = (n: number): number => Math.round(n * 100) / 100;
