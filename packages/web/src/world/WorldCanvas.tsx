import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Arena } from "./Arena.tsx";
import look from "./arenaLook.json";
import { EntitySprite } from "./EntitySprite.tsx";
import { useWorldStore } from "./useWorldStore.ts";

export function WorldCanvas() {
  const env = useWorldStore((s) => s.world.environment);
  const terrain = useWorldStore((s) => s.world.terrain);
  const entities = useWorldStore((s) => s.world.entities);
  const ghosts = useWorldStore((s) => s.ghosts);

  return (
    <div className="world">
      <Canvas camera={{ position: [0, 16, 30], fov: 48, near: 0.1, far: 2000 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
        <color attach="background" args={[env.skyBottom]} />
        <fogExp2 attach="fog" args={[env.fogColor, env.fogDensity * 0.6]} />
        <ambientLight color={env.ambient} intensity={look.lights.ambient} />
        <hemisphereLight args={[env.skyTop, env.groundColor, look.lights.hemisphere]} />
        <directionalLight position={[12, 24, 10]} intensity={look.lights.sun} color={look.lights.sunColor} />
        <Arena env={env} terrain={terrain} />
        {Object.values(entities).map((e) => (
          <EntitySprite key={e.id} entity={e} />
        ))}
        {ghosts.map((g) => (
          <EntitySprite key={`ghost-${g.entity.id}`} entity={g.entity} diedAt={g.diedAt} />
        ))}
        <OrbitControls
          enablePan={false}
          minDistance={12}
          maxDistance={70}
          maxPolarAngle={Math.PI / 2.15}
          autoRotate
          autoRotateSpeed={0.25}
          target={[0, 1.5, 0]}
        />
        <EffectComposer>
          <Bloom luminanceThreshold={look.bloom.threshold} luminanceSmoothing={0.3} intensity={look.bloom.intensity} mipmapBlur />
          <Vignette eskil={false} offset={0.2} darkness={0.7} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
