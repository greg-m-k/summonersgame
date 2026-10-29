import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Arena } from "./Arena.tsx";
import { EntitySprite } from "./EntitySprite.tsx";
import { useWorldStore } from "./useWorldStore.ts";

export function WorldCanvas() {
  const env = useWorldStore((s) => s.world.environment);
  const entities = useWorldStore((s) => s.world.entities);
  const ghosts = useWorldStore((s) => s.ghosts);

  return (
    <div className="world">
      <Canvas camera={{ position: [0, 16, 30], fov: 48, near: 0.1, far: 400 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
        <color attach="background" args={[env.skyBottom]} />
        <fogExp2 attach="fog" args={[env.fogColor, env.fogDensity * 0.6]} />
        <ambientLight color={env.ambient} intensity={1.1} />
        <hemisphereLight args={[env.skyTop, env.groundColor, 0.8]} />
        <directionalLight position={[12, 24, 10]} intensity={1.6} color="#ffffff" />
        <Arena env={env} />
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
          <Bloom luminanceThreshold={0.55} luminanceSmoothing={0.3} intensity={0.85} mipmapBlur />
          <Vignette eskil={false} offset={0.2} darkness={0.7} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
