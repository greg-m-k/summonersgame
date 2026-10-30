import type { WorldEvent } from "./events.ts";
import type { WorldState } from "./world.ts";

/**
 * Apply one event to a world state, returning a new state with structural sharing.
 * Used by the server (authoritative) and the client (mirror) so both agree.
 */
export function applyEvent(state: WorldState, ev: WorldEvent): WorldState {
  switch (ev.type) {
    case "summon":
    case "transform":
      return { ...state, entities: { ...state.entities, [ev.entity.id]: ev.entity } };
    case "entity_image": {
      const e = state.entities[ev.entityId];
      if (!e) return state;
      return { ...state, entities: { ...state.entities, [e.id]: { ...e, imageUrl: ev.url } } };
    }
    case "attack": {
      const entities = { ...state.entities };
      const target = entities[ev.targetId];
      const attacker = entities[ev.attackerId];
      if (target) entities[target.id] = { ...target, hp: ev.targetHp, lastHitBy: attacker?.ownerId ?? null };
      if (attacker) entities[attacker.id] = { ...attacker, targetEntityId: ev.targetId };
      return { ...state, entities };
    }
    case "destroy": {
      if (!state.entities[ev.entityId]) return state;
      const entities: WorldState["entities"] = {};
      for (const [id, e] of Object.entries(state.entities)) {
        if (id === ev.entityId) continue;
        entities[id] = e.targetEntityId === ev.entityId ? { ...e, targetEntityId: null } : e;
      }
      return { ...state, entities };
    }
    case "heal": {
      const e = state.entities[ev.entityId];
      if (!e) return state;
      return { ...state, entities: { ...state.entities, [e.id]: { ...e, hp: ev.hp } } };
    }
    case "warp_world":
      return { ...state, environment: ev.environment };
    case "narrate":
      return state;
    case "points": {
      const p = state.players[ev.playerId];
      if (!p) return state;
      return { ...state, players: { ...state.players, [p.identity]: { ...p, score: ev.score, micBank: ev.micBank, xp: ev.xp } } };
    }
    case "level_up": {
      const p = state.players[ev.playerId];
      if (!p) return state;
      return {
        ...state,
        players: { ...state.players, [p.identity]: { ...p, level: ev.level, talentPoints: ev.talentPoints, micBank: ev.micBank } },
      };
    }
    case "talent": {
      const p = state.players[ev.playerId];
      if (!p) return state;
      return { ...state, players: { ...state.players, [p.identity]: { ...p, talents: ev.talents, talentPoints: ev.talentPoints } } };
    }
    case "mic_time": {
      const p = state.players[ev.playerId];
      if (!p) return state;
      return {
        ...state,
        players: { ...state.players, [p.identity]: { ...p, onRoomMic: ev.on, micBank: ev.micBank } },
      };
    }
    case "player_joined":
    case "player_updated":
      return { ...state, players: { ...state.players, [ev.player.identity]: ev.player } };
    case "player_left": {
      if (!state.players[ev.playerId]) return state;
      const players = { ...state.players };
      delete players[ev.playerId];
      return { ...state, players };
    }
    case "match_started": {
      const entities: WorldState["entities"] = {};
      for (const h of ev.hearts) entities[h.id] = h;
      for (const t of ev.towers) entities[t.id] = t;
      const players: WorldState["players"] = {};
      for (const [id, p] of Object.entries(state.players)) players[id] = { ...p, score: 0 };
      return { ...state, match: ev.match, entities, players, terrain: ev.terrain, wave: 0 };
    }
    case "wave": {
      const entities = { ...state.entities };
      for (const m of ev.minions) entities[m.id] = m;
      return { ...state, entities, wave: ev.number };
    }
    case "match_over":
      return { ...state, match: ev.match };
  }
}
