import { Stars } from "@react-three/drei";
import { useMemo } from "react";
import { BackSide, Color, ShaderMaterial } from "three";
import { ARENA_RADIUS, SPAWN_RADIUS, type Environment } from "@summoners/shared";

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

export function Arena({ env }: { env: Environment }) {
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
        <sphereGeometry args={[160, 32, 16]} />
      </mesh>
      <Stars radius={120} depth={40} count={1800} factor={4} saturation={0.6} fade speed={0.4} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[ARENA_RADIUS + 26, 72]} />
        <meshStandardMaterial color={env.groundColor} roughness={0.95} metalness={0.05} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.02}>
        <ringGeometry args={[SPAWN_RADIUS - 0.08, SPAWN_RADIUS + 0.08, 96]} />
        <meshBasicMaterial color={env.ambient} transparent opacity={0.35} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.015}>
        <ringGeometry args={[ARENA_RADIUS - 0.05, ARENA_RADIUS + 0.05, 128]} />
        <meshBasicMaterial color={env.ambient} transparent opacity={0.18} />
      </mesh>
      <gridHelper args={[90, 45, env.ambient, env.ambient]} position-y={0.01}>
        <meshBasicMaterial attach="material" color={env.ambient} transparent opacity={0.07} />
      </gridHelper>
    </>
  );
}
