import { useFrame } from "@react-three/fiber";
import { type EntitySpec, TEAM_INFO, type TeamId } from "@summoners/shared";
import { useRef } from "react";
import { type Group } from "three";
import look from "./arenaLook.json";

/**
 * A lane minion: a small hooded wisp in its team's colour, no picture needed (there are dozens a
 * match and they all look alike on purpose). Brutes are the same shape, bigger. Bobs as it walks.
 */
export function Minion3D({ entity, team }: { entity: EntitySpec; team: TeamId }) {
  const group = useRef<Group>(null);
  const color = TEAM_INFO[team].color;
  const s = entity.size;
  const L = look.minion;
  useFrame((st) => {
    if (!group.current) return;
    const t = st.clock.elapsedTime * 7 + entity.position.x;
    group.current.position.y = Math.abs(Math.sin(t)) * 0.08 * s;
    group.current.rotation.z = Math.sin(t) * 0.08;
  });
  return (
    <group ref={group} position-y={-s * 0.5}>
      <mesh position-y={s * 0.45} castShadow>
        <coneGeometry args={[s * 0.32, s * 0.9, 6]} />
        <meshStandardMaterial color="#14101f" emissive={color} emissiveIntensity={L.emissiveIntensity * 0.25} roughness={L.roughness} flatShading />
      </mesh>
      <mesh position-y={s * 0.78}>
        <sphereGeometry args={[s * 0.2, 10, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={L.emissiveIntensity} roughness={0.3} />
      </mesh>
      <mesh position={[s * 0.07, s * 0.8, s * 0.17]}>
        <sphereGeometry args={[s * 0.04, 6, 6]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <mesh position={[-s * 0.07, s * 0.8, s * 0.17]}>
        <sphereGeometry args={[s * 0.04, 6, 6]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
    </group>
  );
}
