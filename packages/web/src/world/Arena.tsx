import { Stars } from "@react-three/drei";
import { useMemo } from "react";
import { BackSide, Color, ShaderMaterial } from "three";
import { ARENA_RADIUS, type Environment, type Terrain } from "@summoners/shared";
import baseLook from "./arenaLook.json";
import { Ground } from "./Ground.tsx";
import { type ArenaLook, Terrain3D } from "./Terrain3D.tsx";

const skyVert = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const skyFrag = /* glsl */ `
  uniform vec3 top;
  uniform vec3 bottom;
  varying vec3 vPos;
  void main() {
    float h = normalize(vPos).y * 0.5 + 0.5;
    vec3 c = mix(bottom, top, smoothstep(0.1, 0.85, h));
    gl_FragColor = vec4(c, 1.0);
  }
`;

export function Arena({ env, terrain, lookOverride }: { env: Environment; terrain: Terrain; lookOverride?: ArenaLook }) {
  const L = lookOverride ?? baseLook;
  const sky = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { top: { value: new Color(env.skyTop) }, bottom: { value: new Color(env.skyBottom) } },
        vertexShader: skyVert,
        fragmentShader: skyFrag,
        side: BackSide,
        depthWrite: false,
        fog: false,
      }),
    [],
  );
  sky.uniforms.top!.value.set(env.skyTop);
  sky.uniforms.bottom!.value.set(env.skyBottom);

  return (
    <>
      <mesh material={sky} frustumCulled={false}>
        <sphereGeometry args={[900, 32, 16]} />
      </mesh>
      <Stars radius={120} depth={40} count={L.stars.count} factor={L.stars.factor} saturation={L.stars.saturation} fade speed={0.4} />
      <Ground groundColor={env.groundColor} lineColor={env.ambient} fogColor={env.fogColor} fogDensity={env.fogDensity * L.fogScale} grid={L.grid} />
      <Terrain3D terrain={terrain} lookOverride={L} />
      <mesh rotation-x={-Math.PI / 2} position-y={0.015}>
        <ringGeometry args={[ARENA_RADIUS - 0.05, ARENA_RADIUS + 0.05, 128]} />
        <meshBasicMaterial color={env.ambient} transparent opacity={0.18} />
      </mesh>
    </>
  );
}
