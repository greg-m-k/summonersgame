import { useFrame } from "@react-three/fiber";
import { type EntitySpec, TEAM_INFO, type TeamId } from "@summoners/shared";
import { useRef } from "react";
import { AdditiveBlending, Color, type Group, type Mesh, type PointLight } from "three";
import look from "./arenaLook.json";
import { useWorldStore } from "./useWorldStore.ts";

/**
 * A lane tower: a dark obelisk with a floating eye in the team's colour that turns to face whatever
 * it is shooting. The eye dims as the tower is worn down.
 */
export function Tower3D({ entity, team }: { entity: EntitySpec; team: TeamId }) {
  const eye = useRef<Mesh>(null);
  const halo = useRef<Group>(null);
  const light = useRef<PointLight>(null);
  const targetPos = useWorldStore((s) => (entity.targetEntityId ? s.positions[entity.targetEntityId] : undefined));
  const color = TEAM_INFO[team].color;
  const hp = entity.hp / Math.max(1, entity.maxHp);
  const h = entity.size;
  const L = look.tower;

  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (eye.current) {
      eye.current.position.y = h + 0.6 + Math.sin(t * 1.6) * 0.1;
      eye.current.rotation.y += 0.01;
      if (targetPos) {
        const dx = targetPos[0] - entity.position.x;
        const dz = targetPos[2] - entity.position.z;
        eye.current.rotation.y = Math.atan2(dx, dz);
      }
      const m = eye.current.material as { emissiveIntensity?: number };
      m.emissiveIntensity = L.eyeIntensity * (0.5 + hp * 0.5) * (targetPos ? 1 + Math.sin(t * 12) * 0.3 : 1);
    }
    if (halo.current) halo.current.rotation.y = t * 0.6;
    if (light.current) light.current.intensity = L.lightIntensity * (0.4 + hp * 0.6);
  });

  return (
    <group>
      <mesh position-y={h * 0.5} castShadow>
        <cylinderGeometry args={[0.35, 0.8, h, 6]} />
        <meshStandardMaterial color={L.bodyColor} roughness={L.roughness} flatShading />
      </mesh>
      <mesh position-y={0.12}>
        <cylinderGeometry args={[1.1, 1.3, 0.24, 6]} />
        <meshStandardMaterial color={L.bodyColor} roughness={L.roughness} flatShading />
      </mesh>
      <mesh ref={eye} position-y={h + 0.6}>
        <octahedronGeometry args={[0.45, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={L.eyeIntensity} roughness={0.2} />
      </mesh>
      <group ref={halo} position-y={h + 0.6}>
        <mesh rotation-x={Math.PI / 2}>
          <torusGeometry args={[0.8, 0.03, 6, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
      </group>
      <pointLight ref={light} color={color} intensity={L.lightIntensity} distance={9} decay={2} position-y={h + 0.6} />
      <mesh rotation-x={-Math.PI / 2} position-y={0.03}>
        <ringGeometry args={[entity.range ?? 6, (entity.range ?? 6) + 0.08, 64]} />
        <meshBasicMaterial color={new Color(color).multiplyScalar(L.ringAlpha)} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}
