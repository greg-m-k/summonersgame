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
    float far = exp(-dist * 0.02);
    float g = max(minor * 0.55, major) * lineAlpha * far;
    vec3 c = mix(ground, line, g);
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    c = mix(c, fogColor, clamp(fogFactor, 0.0, 1.0));
    gl_FragColor = vec4(c, 1.0);
  }
`;

export function Ground({ groundColor, lineColor, fogColor, fogDensity }: { groundColor: string; lineColor: string; fogColor: string; fogDensity: number }) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          ground: { value: new Color(groundColor) },
          line: { value: new Color(lineColor) },
          fogColor: { value: new Color(fogColor) },
          fogDensity: { value: fogDensity },
          cell: { value: 2 },
          majorEvery: { value: 5 },
          lineAlpha: { value: 0.13 },
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
  return (
    <mesh rotation-x={-Math.PI / 2} material={material} receiveShadow frustumCulled={false}>
      <planeGeometry args={[1600, 1600, 1, 1]} />
    </mesh>
  );
}
