import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import {
  DEFAULT_ENVIRONMENT,
  type EntitySpec,
  LANE_IDS,
  TEAM_IDS,
  TEAM_INFO,
  TOWER_HP,
  TOWER_RANGE,
  type TeamId,
  generateTerrain,
  heartId,
  heartOwner,
  towerSpot,
} from "@summoners/shared";
import { useEffect, useMemo } from "react";
import { Arena } from "../world/Arena.tsx";
import baseLook from "../world/arenaLook.json";
import { EntitySprite } from "../world/EntitySprite.tsx";
import { type ArenaLook } from "../world/Terrain3D.tsx";
import { useWorldStore } from "../world/useWorldStore.ts";

/**
 * /lab/arena: a full field with no server behind it, for eyeballing and for the judge loop. Hearts,
 * towers, a minion wave mid-march and a couple of placeholder creatures, all from the seed.
 * ?seed=7 picks the field; ?look=<base64 json> overrides arenaLook.json; ?cam=high|low picks the view.
 */
export function ArenaLab() {
  const params = new URLSearchParams(window.location.search);
  const seed = Number(params.get("seed") ?? 3);
  const cam = params.get("cam") ?? "game";
  const look = useMemo<ArenaLook>(() => {
    const raw = params.get("look");
    if (!raw) return baseLook;
    try {
      return deepMerge(baseLook, JSON.parse(atob(raw)) as Partial<ArenaLook>);
    } catch {
      return baseLook;
    }
  }, [params]);
  const terrain = useMemo(() => generateTerrain(seed), [seed]);
  const entities = useMemo(() => fieldEntities(terrain), [terrain]);
  // The lab shares the world store so EntitySprite can resolve teams and positions as in a match.
  useEffect(() => {
    useWorldStore.getState().setSnapshot({
      room: "lab",
      tick: 0,
      entities: Object.fromEntries(entities.map((e) => [e.id, e])),
      environment: DEFAULT_ENVIRONMENT,
      players: {},
      match: { number: 1, phase: "live", startedAt: 0, endedAt: null, winner: null },
      terrain,
      wave: 1,
    });
  }, [entities, terrain]);
  const env = DEFAULT_ENVIRONMENT;
  const camera = cam === "high" ? { position: [0, 30, 26] as [number, number, number], fov: 45 } : cam === "low" ? { position: [14, 5, 22] as [number, number, number], fov: 50 } : { position: [0, 16, 30] as [number, number, number], fov: 48 };
  return (
    <div className="world">
      <Canvas camera={{ ...camera, near: 0.1, far: 2000 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
        <color attach="background" args={[env.skyBottom]} />
        <fogExp2 attach="fog" args={[env.fogColor, env.fogDensity * look.fogScale]} />
        <ambientLight color={env.ambient} intensity={look.lights.ambient} />
        <hemisphereLight args={[env.skyTop, env.groundColor, look.lights.hemisphere]} />
        <directionalLight position={[12, 24, 10]} intensity={look.lights.sun} color={look.lights.sunColor} />
        <Arena env={env} terrain={terrain} lookOverride={look} />
        {entities.map((e) => (
          <EntitySprite key={e.id} entity={e} />
        ))}
        <OrbitControls enablePan={false} minDistance={8} maxDistance={70} maxPolarAngle={Math.PI / 2.15} target={[0, 1.5, 0]} />
        <EffectComposer>
          <Bloom luminanceThreshold={look.bloom.threshold} luminanceSmoothing={0.3} intensity={look.bloom.intensity} mipmapBlur />
          <Vignette eskil={false} offset={0.2} darkness={0.7} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

function deepMerge<T>(a: T, b: unknown): T {
  if (!b || typeof b !== "object" || Array.isArray(b)) return (b ?? a) as T;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out as T;
}

function fieldEntities(terrain: ReturnType<typeof generateTerrain>): EntitySpec[] {
  const stub = (id: string, team: TeamId, label: string, x: number, z: number, over: Partial<EntitySpec>): EntitySpec => ({
    id,
    ownerId: heartOwner(team),
    label,
    imagePrompt: "",
    size: 1,
    hp: 100,
    maxHp: 100,
    attack: 10,
    speed: 2,
    fx: "none",
    idleAnim: "bob",
    moveStyle: "walk",
    placeholderColor: TEAM_INFO[team].color,
    imageUrl: null,
    position: { x, y: 0, z },
    target: null,
    targetEntityId: null,
    bornAt: 0,
    ...over,
  });
  const out: EntitySpec[] = [];
  for (const team of TEAM_IDS) {
    const hx = Math.cos(TEAM_INFO[team].angle) * 11;
    out.push(stub(heartId(team), team, `Heart of ${TEAM_INFO[team].name}`, hx, 0, { size: 4, hp: 1200, maxHp: 1200, attack: 0, speed: 0, heart: true, idleAnim: "pulse", fx: "sparkles" }));
    for (const lane of terrain.lanes) {
      const spot = towerSpot(lane, team);
      out.push(stub(`tower-${team}-${lane.id}`, team, `${TEAM_INFO[team].name} ${lane.id} tower`, spot.x, spot.z, { size: 3, hp: TOWER_HP * 0.7, maxHp: TOWER_HP, speed: 0, kind: "tower", lane: lane.id, range: TOWER_RANGE }));
      // A wave mid-march: minions at 45% and 55% of the lane, brute on mid.
      const pts = team === "ash" ? lane.points : [...lane.points].reverse();
      for (const [i, t] of [0.42, 0.5].entries()) {
        const p = pts[Math.round((pts.length - 1) * t)]!;
        const brute = lane.id === "mid" && i === 0;
        out.push(stub(`m-${team}-${lane.id}-${i}`, team, brute ? `${TEAM_INFO[team].name} brute` : `${TEAM_INFO[team].name} minion`, p.x, p.z + (i - 0.5) * 0.9, { size: brute ? 1.4 : 0.8, hp: 40, maxHp: 55, kind: "minion", lane: lane.id, waypoint: 3 }));
      }
    }
  }
  void LANE_IDS;
  out.push(stub("e-lab-1", "ash", "Flaming Whale", 3, 3, { size: 3, hp: 300, maxHp: 400, fx: "fire", placeholderColor: "#ff7a1a", ownerId: "lab-ash" }));
  out.push(stub("e-lab-2", "tide", "Glass Spider", -4, -3, { size: 2, hp: 120, maxHp: 200, fx: "lightning", placeholderColor: "#4fc3f7", ownerId: "lab-tide" }));
  return out;
}
