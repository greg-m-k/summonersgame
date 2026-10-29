import { z } from "zod";

export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3>;

export const Fx = z.enum(["none", "fire", "sparkles", "lightning", "smoke"]);
export type Fx = z.infer<typeof Fx>;
export const IdleAnim = z.enum(["bob", "spin", "pulse", "float"]);
export type IdleAnim = z.infer<typeof IdleAnim>;
export const MoveStyle = z.enum(["walk", "hover", "slither", "teleport"]);
export type MoveStyle = z.infer<typeof MoveStyle>;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex color like #ff00aa");

// ---- teams and the match ------------------------------------------------------------------------

export const TeamId = z.enum(["ash", "tide"]);
export type TeamId = z.infer<typeof TeamId>;
export const TEAM_IDS: readonly TeamId[] = ["ash", "tide"];

/** Two sides of the arena. Hearts sit on the team's angle; creatures spawn on that half. */
export const TEAM_INFO: Record<TeamId, { name: string; color: string; angle: number }> = {
  ash: { name: "Ash", color: "#ff7a1a", angle: 0 },
  tide: { name: "Tide", color: "#4fc3f7", angle: Math.PI },
};

export const otherTeam = (team: TeamId): TeamId => (team === "ash" ? "tide" : "ash");
/** Hearts are entities owned by their team rather than by a player. */
export const heartOwner = (team: TeamId): string => `team:${team}`;
export const heartId = (team: TeamId): string => `heart-${team}`;

export const MatchPhase = z.enum(["live", "over"]);
export const MatchState = z.object({
  number: z.number().int(),
  phase: MatchPhase,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  winner: TeamId.nullable(),
});
export type MatchState = z.infer<typeof MatchState>;

export const DEFAULT_MATCH: MatchState = { number: 0, phase: "live", startedAt: 0, endedAt: null, winner: null };

// ---- entities -------------------------------------------------------------------------------------

/** Fields the game master supplies when summoning. The server fills in the rest. */
export const SummonInput = z.object({
  ownerId: z.string().describe("identity of the player whose words caused this"),
  label: z.string().min(1).max(40).describe("short name shown above the thing"),
  imagePrompt: z
    .string()
    .min(4)
    .max(300)
    .describe(
      "concrete visual description of the thing, one subject, full body, no text. Do not mention background or style; the server adds those.",
    ),
  size: z.number().min(0.3).max(12).describe("height in meters, 1 = human"),
  hp: z.number().int().min(1).max(1000),
  attack: z.number().int().min(0).max(500),
  speed: z.number().min(0).max(20).describe("meters per second"),
  fx: Fx,
  idleAnim: IdleAnim,
  moveStyle: MoveStyle,
  placeholderColor: HexColor.describe("glow color shown while the image renders"),
});
export type SummonInput = z.infer<typeof SummonInput>;

export const EntitySpec = SummonInput.extend({
  id: z.string(),
  imageUrl: z.string().nullable(),
  /** Summons are capped at 1000 hp by the game master's schema; hearts and transforms are not. */
  hp: z.number().int().min(0),
  maxHp: z.number().int().min(1),
  position: Vec3,
  target: Vec3.nullable(),
  targetEntityId: z.string().nullable(),
  bornAt: z.number(),
  /** A team's heart: it does not move or attack, and the match ends when it dies. */
  heart: z.boolean().optional(),
  /** Owner id of whoever hit this last, for kill credit and bribe checks. */
  lastHitBy: z.string().nullable().optional(),
  /** Kills this creature made; each one makes it 10% stronger (shown as stars). */
  kills: z.number().int().optional(),
  /** Second Wind already saved this creature once. */
  spared: z.boolean().optional(),
});
export type EntitySpec = z.infer<typeof EntitySpec>;

export const Environment = z.object({
  skyTop: HexColor,
  skyBottom: HexColor,
  fogColor: HexColor,
  fogDensity: z.number().min(0).max(0.2),
  groundColor: HexColor,
  ambient: HexColor,
  gravity: z.number().min(-20).max(20).describe("9.8 normal, 0 floaty, negative = things fall up"),
  terrainSeed: z.number().int(),
  mood: z.string().max(60).describe("two or three words, shown to players"),
});
export type Environment = z.infer<typeof Environment>;

export const DEFAULT_ENVIRONMENT: Environment = {
  skyTop: "#1a0b3a",
  skyBottom: "#4b1d7a",
  fogColor: "#3a1560",
  fogDensity: 0.03,
  groundColor: "#2a1246",
  ambient: "#8a5cff",
  gravity: 9.8,
  terrainSeed: 1,
  mood: "uneasy violet calm",
};

export const PlayerState = z.object({
  identity: z.string(),
  name: z.string(),
  persona: z.string(),
  demonIdentity: z.string().nullable(),
  team: TeamId,
  /** Match score; resets every match. */
  score: z.number().int(),
  /** Experience across the whole session; never resets. */
  xp: z.number().int(),
  level: z.number().int(),
  talentPoints: z.number().int(),
  talents: z.array(z.string()),
  micBank: z.number().describe("seconds of room-mic time available"),
  onRoomMic: z.boolean(),
  zoneIndex: z.number().int(),
});
export type PlayerState = z.infer<typeof PlayerState>;

export const WorldState = z.object({
  room: z.string(),
  tick: z.number().int(),
  entities: z.record(z.string(), EntitySpec),
  environment: Environment,
  players: z.record(z.string(), PlayerState),
  match: MatchState,
});
export type WorldState = z.infer<typeof WorldState>;

/** Snapshot sent through room metadata so late joiners catch up. */
export const WorldSnapshot = WorldState;
export type WorldSnapshot = WorldState;

export function emptyWorld(room: string): WorldState {
  return { room, tick: 0, entities: {}, environment: { ...DEFAULT_ENVIRONMENT }, players: {}, match: { ...DEFAULT_MATCH } };
}

/** Which team an owner id belongs to: a team's own heart, or a player's team. */
export function teamOfOwner(state: Pick<WorldState, "players">, ownerId: string): TeamId | null {
  if (ownerId.startsWith("team:")) {
    const t = ownerId.slice(5);
    return TeamId.safeParse(t).success ? (t as TeamId) : null;
  }
  return state.players[ownerId]?.team ?? null;
}

/** Mic seconds a point pays by itself; levels, bribes, and the Silver Tongue talent pay the rest. */
export const SECONDS_PER_POINT = 2;
export const ARENA_RADIUS = 14;
export const SPAWN_RADIUS = 9;
export const MAX_ENTITIES = 40;

/** Combat engine constants (server authoritative; here so the client can explain them). */
export const HEART_HP = 1200;
export const HEART_RADIUS = 11;
/** A creature picks the nearest enemy within this many meters; otherwise it marches on the heart. */
export const AGGRO_RADIUS = 7;
export const ATTACK_COOLDOWN_S = 1.2;
/** Each hit does this fraction of the attacker's attack stat, give or take a quarter. */
export const HIT_FRACTION = 0.25;
/** How long the result screen stays up before the next match starts. */
export const MATCH_OVER_MS = 15_000;
