import { useMemo } from "react";
import { Color, DoubleSide, ShaderMaterial } from "three";

/**
 * Ground that reaches the horizon: one huge plane with the grid drawn in the shader in world space,
 * anti-aliased by screen derivative, so lines stay thin near the camera and dissolve into the fog
 * far away instead of ending at a visible edge.
 */
const vert = /* glsl */ `
  varying vec3 vWorld;
  varying float vFogDepth;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vec4 mv = viewMatrix * w;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const frag = /* glsl */ `
  uniform vec3 ground;
  uniform vec3 line;
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform float cell;
  uniform float majorEvery;
  uniform float lineAlpha;
  uniform float farFade;
  varying vec3 vWorld;
  varying float vFogDepth;

  float gridLine(vec2 p, float spacing, float width) {
    vec2 q = p / spacing;
    vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
    float d = min(g.x, g.y);
    return 1.0 - smoothstep(width, width + 1.0, d);
  }

  void main() {
    vec2 p = vWorld.xz;
    float minor = gridLine(p, cell, 0.6);
    float major = gridLine(p, cell * majorEvery, 1.0);
    float dist = length(p);
    // lines thin out with distance so the far field is a calm haze, not moiré
    float far = exp(-dist * farFade);
    float g = max(minor * 0.55, major) * lineAlpha * far;
    vec3 c = mix(ground, line, g);
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    c = mix(c, fogColor, clamp(fogFactor, 0.0, 1.0));
    gl_FragColor = vec4(c, 1.0);
  }
`;

export interface GridLook {
  cell: number;
  majorEvery: number;
  lineAlpha: number;
  farFade: number;
}

export function Ground({ groundColor, lineColor, fogColor, fogDensity, grid }: { groundColor: string; lineColor: string; fogColor: string; fogDensity: number; grid: GridLook }) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          ground: { value: new Color(groundColor) },
          line: { value: new Color(lineColor) },
          fogColor: { value: new Color(fogColor) },
          fogDensity: { value: fogDensity },
          cell: { value: grid.cell },
          majorEvery: { value: grid.majorEvery },
          lineAlpha: { value: grid.lineAlpha },
          farFade: { value: grid.farFade },
        },
        vertexShader: vert,
        fragmentShader: frag,
        side: DoubleSide,
        fog: false,
      }),
    [],
  );
  material.uniforms.ground!.value.set(groundColor);
  material.uniforms.line!.value.set(lineColor);
  material.uniforms.fogColor!.value.set(fogColor);
  material.uniforms.fogDensity!.value = fogDensity;
  material.uniforms.cell!.value = grid.cell;
  material.uniforms.majorEvery!.value = grid.majorEvery;
  material.uniforms.lineAlpha!.value = grid.lineAlpha;
  material.uniforms.farFade!.value = grid.farFade;
  return (
    <mesh rotation-x={-Math.PI / 2} material={material} receiveShadow frustumCulled={false}>
      <planeGeometry args={[1600, 1600, 1, 1]} />
    </mesh>
  );
}
