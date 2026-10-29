import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Environment, SummonInput } from "@summoners/shared";
import { z } from "zod";
import type { World } from "../world/state.ts";

const entityId = z.string().describe("entity id from the snapshot, like e-1a2b3c");

const AttackInput = z.object({
  attackerId: entityId,
  targetId: entityId,
  damage: z.number().int().min(0).max(1000).describe("hp removed from the target this instant"),
  flavor: z.string().max(120).describe("five to fifteen words of how the hit lands"),
});

const DestroyInput = z.object({
  entityId,
  cause: z.string().max(120),
});

const TransformInput = SummonInput.omit({ ownerId: true })
  .partial()
  .extend({
    entityId,
    description: z.string().max(120).describe("what changed, five to fifteen words"),
  });

const WarpInput = Environment.partial().extend({
  description: z.string().max(120).describe("what the dream did, five to fifteen words"),
});

const AwardInput = z.object({
  playerId: z.string().describe("player identity from the snapshot"),
  points: z.number().int().min(1).max(10),
  reason: z.string().max(80),
});

const NarrateInput = z.object({ text: z.string().max(240) });

/** Game-master tools bound to one room's world. Every run() mutates the world and returns a short result. */
export function makeGmTools(world: World) {
  const summon = betaZodTool({
    name: "summon",
    description:
      "Bring a new thing into the dream because a player described or asked for it. Use for creatures, objects, people, weather-shaped beings, anything with a body.",
    inputSchema: SummonInput,
    run: async (input) => {
      if (!world.player(input.ownerId)) return `error: unknown ownerId ${input.ownerId}`;
      const e = world.summon(input);
      return `summoned ${e.id} "${e.label}" for ${input.ownerId} at (${e.position.x}, ${e.position.z})`;
    },
    eager_input_streaming: true,
  });

  const attack = betaZodTool({
    name: "attack",
    description:
      "A strike a player explicitly ordered: one entity hits another right now (creatures fight on their own otherwise). Pick damage from the attacker's attack stat and the drama of the moment. The attacker keeps fighting that target afterwards, teammates' things included.",
    inputSchema: AttackInput,
    run: async (input) => {
      const r = world.attack(input.attackerId, input.targetId, input.damage, input.flavor);
      if (!r) return `error: attacker or target not found (or same entity)`;
      return r.destroyed ? `${input.targetId} destroyed` : `${input.targetId} now at ${r.targetHp} hp`;
    },
    eager_input_streaming: true,
  });

  const destroy = betaZodTool({
    name: "destroy",
    description: "Remove an entity from the dream outright: it dissolves, leaves, explodes, is unmade.",
    inputSchema: DestroyInput,
    run: async (input) => (world.destroy(input.entityId, input.cause) ? `${input.entityId} gone` : `error: not found`),
    eager_input_streaming: true,
  });

  const transform = betaZodTool({
    name: "transform",
    description:
      "Change an existing entity: bigger, on fire, new shape, more hp. Give imagePrompt only when its appearance changes, since that re-renders its picture.",
    inputSchema: TransformInput,
    run: async ({ entityId: id, description, ...patch }) => {
      const e = world.transform(id, patch, description);
      return e ? `${id} is now "${e.label}" size ${e.size} hp ${e.hp}` : `error: not found`;
    },
    eager_input_streaming: true,
  });

  const warp_world = betaZodTool({
    name: "warp_world",
    description: "Change the dream itself: sky, fog, ground, gravity, mood. Only include the fields that change.",
    inputSchema: WarpInput,
    run: async ({ description, ...patch }) => {
      const env = world.warp(patch, description);
      return `world is now "${env.mood}"`;
    },
    eager_input_streaming: true,
  });

  const award_points = betaZodTool({
    name: "award_points",
    description: "Give a player points for creativity, kills, or chaos. Points buy them room-microphone seconds.",
    inputSchema: AwardInput,
    run: async (input) => {
      const p = world.awardPoints(input.playerId, input.points, input.reason);
      return p ? `${p.name} now has ${p.score} points` : `error: unknown player`;
    },
    eager_input_streaming: true,
  });

  const narrate = betaZodTool({
    name: "narrate",
    description: "Optional extra line of narration for a moment that deserves it. Your final text reply is also narrated.",
    inputSchema: NarrateInput,
    run: async ({ text }) => {
      world.narrate(text);
      return "ok";
    },
    eager_input_streaming: true,
  });

  return [summon, attack, destroy, transform, warp_world, award_points, narrate];
}
