import { z } from "zod";
import { EntitySpec, Environment, MatchState, PlayerState, TeamId, Vec3 } from "./world.ts";

export const WorldEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("summon"), entity: EntitySpec }),
  z.object({ type: z.literal("entity_image"), entityId: z.string(), url: z.string() }),
  z.object({
    type: z.literal("attack"),
    attackerId: z.string(),
    targetId: z.string(),
    damage: z.number().int(),
    targetHp: z.number().int(),
    flavor: z.string(),
    /** True when the combat engine swung, false or absent when the game master ordered the strike. */
    auto: z.boolean().optional(),
  }),
  z.object({ type: z.literal("destroy"), entityId: z.string(), cause: z.string() }),
  /** Quiet hp change (Regrowth); feeds ignore it. */
  z.object({ type: z.literal("heal"), entityId: z.string(), hp: z.number().int() }),
  z.object({ type: z.literal("transform"), entity: EntitySpec, description: z.string() }),
  z.object({ type: z.literal("warp_world"), environment: Environment, description: z.string() }),
  z.object({ type: z.literal("narrate"), text: z.string() }),
  z.object({
    type: z.literal("points"),
    playerId: z.string(),
    points: z.number().int(),
    reason: z.string(),
    score: z.number().int(),
    micBank: z.number(),
    xp: z.number().int(),
  }),
  /** A level reached: a talent point and some mic seconds. */
  z.object({ type: z.literal("level_up"), playerId: z.string(), level: z.number().int(), talentPoints: z.number().int(), micBank: z.number() }),
  /** A talent taken. Public: everyone can see what a player is building toward. */
  z.object({ type: z.literal("talent"), playerId: z.string(), talentId: z.string(), talents: z.array(z.string()), talentPoints: z.number().int() }),
  z.object({ type: z.literal("mic_time"), playerId: z.string(), on: z.boolean(), micBank: z.number() }),
  z.object({ type: z.literal("player_joined"), player: PlayerState }),
  z.object({ type: z.literal("player_left"), playerId: z.string() }),
  z.object({ type: z.literal("player_updated"), player: PlayerState }),
  /** A new match: the arena is cleared, scores reset, two fresh hearts placed. */
  z.object({ type: z.literal("match_started"), match: MatchState, hearts: z.array(EntitySpec) }),
  /** A heart fell. Scores are final and every bribe taken this match is revealed. */
  z.object({
    type: z.literal("match_over"),
    match: MatchState,
    winner: TeamId.nullable(),
    scores: z.record(z.string(), z.number()),
    bribes: z.record(z.string(), z.array(z.string())),
  }),
]);
export type WorldEvent = z.infer<typeof WorldEvent>;

/** Lossy, high-rate position updates: [id, x, y, z] tuples. */
export const PositionsPacket = z.object({
  type: z.literal("positions"),
  at: z.number(),
  items: z.array(z.tuple([z.string(), z.number(), z.number(), z.number()])),
});
export type PositionsPacket = z.infer<typeof PositionsPacket>;

export { Vec3 };
