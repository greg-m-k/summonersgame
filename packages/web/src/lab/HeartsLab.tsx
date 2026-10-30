import { OrbitControls, Stars } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { type EntitySpec, TEAM_IDS, TEAM_INFO, DEFAULT_ENVIRONMENT, generateTerrain, heartId, heartOwner } from "@summoners/shared";
import { Arena } from "../world/Arena.tsx";
import { useMemo } from "react";
import { Heart3D, type HeartLook } from "../world/heart3d/Heart3D.tsx";
import baseLook from "../world/heart3d/heartLook.json";

/**
 * /lab/hearts: both hearts, big, under the arena's light, for eyeballing and for the judge loop.
 * ?hp=0.3 sets both hearts' health; ?look=<base64 json> overrides heartLook.json for one render;
 * ?still=1 freezes the pose (three-quarter view, no float) so the judge compares like with like;
 * ?arena=1 uses the real arena (sky, ground grid, camera) instead of the studio backdrop.
 */
export function HeartsLab() {
  const params = new URLSearchParams(window.location.search);
  const hp = Math.max(0.01, Math.min(1, Number(params.get("hp") ?? 1)));
  const still = params.get("still") === "1";
  const arena = params.get("arena") === "1";
  const env = DEFAULT_ENVIRONMENT;
  const look = useMemo<HeartLook>(() => {
    const raw = params.get("look");
    let l = baseLook;
    try {
      if (raw) l = { ...baseLook, ...(JSON.parse(atob(raw)) as Partial<HeartLook>) } as HeartLook;
    } catch {
      l = baseLook;
    }
    return still ? { ...l, rotateSpeed: 0, float: { ...l.float, amplitude: 0 }, pose: 0.5 } : l;
  }, [params]);
  const hearts: Array<{ entity: EntitySpec; team: (typeof TEAM_IDS)[number] }> = TEAM_IDS.map((team) => ({
    team,
    entity: {
      id: heartId(team),
      ownerId: heartOwner(team),
      label: `Heart of ${TEAM_INFO[team].name}`,
      imagePrompt: "",
      size: 4,
      hp: Math.round(1200 * hp),
      maxHp: 1200,
      attack: 0,
      speed: 0,
      fx: "sparkles",
      idleAnim: "pulse",
      moveStyle: "walk",
      placeholderColor: TEAM_INFO[team].color,
      imageUrl: null,
      position: { x: 0, y: 0, z: 0 },
      target: null,
      targetEntityId: null,
      bornAt: 0,
      heart: true,
    },
  }));
  if (arena) {
    return (
      <div className="world">
        <Canvas camera={{ position: [0, 16, 30], fov: 48, near: 0.1, far: 2000 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
          <color attach="background" args={[env.skyBottom]} />
          <fogExp2 attach="fog" args={[env.fogColor, env.fogDensity * 0.6]} />
          <ambientLight color={env.ambient} intensity={1.1} />
          <hemisphereLight args={[env.skyTop, env.groundColor, 0.8]} />
          <directionalLight position={[12, 24, 10]} intensity={1.6} color="#ffffff" />
          <Arena env={env} terrain={generateTerrain(3)} />
          {hearts.map((h, i) => (
            <group key={h.team} position={[i === 0 ? -14 : 14, 2, 0]}>
              <Heart3D entity={h.entity} team={h.team} lookOverride={look} />
            </group>
          ))}
          <OrbitControls enablePan={false} minDistance={12} maxDistance={70} maxPolarAngle={Math.PI / 2.15} target={[0, 1.5, 0]} />
          <EffectComposer>
            <Bloom luminanceThreshold={0.55} luminanceSmoothing={0.3} intensity={0.85} mipmapBlur />
            <Vignette eskil={false} offset={0.2} darkness={0.7} />
          </EffectComposer>
        </Canvas>
      </div>
    );
  }
  return (
    <div className="world" style={{ background: "#0b0616" }}>
      <Canvas camera={{ position: [0, 4, 20], fov: 40 }} shadows gl={{ antialias: true }}>
        <color attach="background" args={["#120826"]} />
        <fogExp2 attach="fog" args={["#2a1246", 0.03]} />
        <ambientLight intensity={0.35} color="#8a5cff" />
        <directionalLight position={[6, 10, 4]} intensity={1.6} color="#ffe9d6" castShadow />
        <directionalLight position={[-6, 4, -4]} intensity={0.6} color="#6fb6ff" />
        <Stars radius={60} depth={30} count={1500} factor={3} fade />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.6, 0]} receiveShadow>
          <circleGeometry args={[14, 64]} />
          <meshStandardMaterial color="#2a1246" roughness={0.9} />
        </mesh>
        {hearts.map((h, i) => (
          <group key={h.team} position={[i === 0 ? -5.5 : 5.5, 0.5, 0]}>
            <Heart3D entity={h.entity} team={h.team} lookOverride={look} />
          </group>
        ))}
        <OrbitControls enablePan={false} target={[0, 0.2, 0]} />
        <EffectComposer>
          <Bloom intensity={0.9} luminanceThreshold={0.55} luminanceSmoothing={0.3} mipmapBlur />
          <Vignette eskil={false} offset={0.2} darkness={0.7} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
