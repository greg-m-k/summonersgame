import { Billboard, Html, Sparkles, useTexture } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type ReactNode, Suspense, useMemo, useRef } from "react";
import { Color, DoubleSide, type Group, ShaderMaterial, type Texture, Vector2 } from "three";
import { type EntitySpec, type Fx, TEAM_INFO, teamOfOwner } from "@summoners/shared";
import { withBase } from "../api.ts";
import { Heart3D } from "./heart3d/Heart3D.tsx";
import { useWorldStore } from "./useWorldStore.ts";

const vert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// Chroma key on the flat background the image prompt asks for, plus hit flash and death dissolve.
// keyColor is sampled from the picture's own border (image models rarely hit #ff00ff exactly), and
// the comparison is on chromaticity (hue and saturation, not brightness) so shading in the
// background still keys while dark or grey details on the subject do not.
const frag = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 keyColor;
  uniform vec2 texel;
  uniform float flash;
  uniform float dissolve;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  vec3 chroma(vec3 c) { return c / max(c.r + c.g + c.b, 1e-4); }
  // 1 where this texel is background. A colourful key (the magenta we ask for) matches on hue and
  // saturation so shading still keys; a grey key (model ignored the prompt) can only match on plain
  // colour distance.
  float keyAt(vec2 uv) {
    vec3 c = texture2D(map, uv).rgb;
    float klum = max(max(keyColor.r, keyColor.g), keyColor.b);
    float ksat = (klum - min(min(keyColor.r, keyColor.g), keyColor.b)) / max(klum, 1e-4);
    if (ksat < 0.25) return 1.0 - smoothstep(0.06, 0.16, distance(c, keyColor));
    float lum = max(max(c.r, c.g), c.b);
    float sat = (lum - min(min(c.r, c.g), c.b)) / max(lum, 1e-4);
    float d = distance(chroma(c), chroma(keyColor));
    return (1.0 - smoothstep(0.05, 0.18, d)) * smoothstep(0.15, 0.4, sat) * smoothstep(0.02, 0.12, lum);
  }
  void main() {
    vec4 c = texture2D(map, vUv);
    // Erode: a texel next to background counts as background, which eats the anti-aliased rim where
    // the model blended the subject into the backdrop (the "pink outline").
    vec2 o = texel * 1.5;
    float key = keyAt(vUv);
    key = max(key, max(keyAt(vUv + vec2(o.x, 0.0)), keyAt(vUv - vec2(o.x, 0.0))));
    key = max(key, max(keyAt(vUv + vec2(0.0, o.y)), keyAt(vUv - vec2(0.0, o.y))));
    float a = (1.0 - key) * c.a;
    if (a < 0.05) discard;
    if (hash(floor(vUv * 48.0)) < dissolve) discard;
    // Despill: anything still leaning toward the background hue loses that tint.
    float d = distance(chroma(c.rgb), chroma(keyColor));
    float spill = 1.0 - smoothstep(0.12, 0.3, d);
    vec3 col = mix(c.rgb, vec3(dot(c.rgb, vec3(0.3333))), spill * 0.85);
    col = mix(col, vec3(1.0, 0.95, 0.8), flash);
    col = mix(col, vec3(1.0, 0.4, 0.1), dissolve * 0.6);
    gl_FragColor = vec4(col, a * (1.0 - dissolve * 0.5));
  }
`;

function texelSize(texture: Texture): Vector2 {
  const img = texture.image as { width?: number; height?: number } | undefined;
  return new Vector2(1 / (img?.width || 512), 1 / (img?.height || 512));
}

/**
 * The background colour the model actually painted: the average of saturated pixels along the
 * picture's border. Falls back to pure magenta when the border is not a flat colour.
 */
function sampleKeyColor(texture: Texture): Color {
  const fallback = new Color("#ff00ff");
  const img = texture.image as CanvasImageSource | undefined;
  if (!img || typeof document === "undefined") return fallback;
  try {
    const n = 32;
    const canvas = document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.drawImage(img, 0, 0, n, n);
    const data = ctx.getImageData(0, 0, n, n).data;
    const ring: [number, number, number][] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (x > 1 && x < n - 2 && y > 1 && y < n - 2) continue; // two-pixel ring
        const i = (y * n + x) * 4;
        ring.push([data[i]!, data[i + 1]!, data[i + 2]!]);
      }
    }
    const mean = (px: [number, number, number][]): [number, number, number] => {
      const s: [number, number, number] = [0, 0, 0];
      for (const p of px) for (let k = 0; k < 3; k++) s[k] += p[k]!;
      return [s[0] / px.length, s[1] / px.length, s[2] / px.length];
    };
    const all = mean(ring);
    const spread = ring.reduce((a, p) => a + Math.abs(p[0] - all[0]) + Math.abs(p[1] - all[1]) + Math.abs(p[2] - all[2]), 0) / ring.length / 3;
    let key: [number, number, number];
    if (spread < 18) {
      key = all; // flat border, whatever its colour (grey backgrounds key on plain distance in the shader)
    } else {
      const colourful = ring.filter(([pr, pg, pb]) => {
        const max = Math.max(pr, pg, pb);
        return max >= 60 && (max - Math.min(pr, pg, pb)) / max >= 0.35;
      });
      if (colourful.length < 12) return fallback;
      key = mean(colourful);
    }
    // Raw byte values on purpose: TextureLoader leaves the texture in NoColorSpace, so the shader
    // samples the encoded bytes, and the key must be in the same space.
    const color = new Color(key[0] / 255, key[1] / 255, key[2] / 255);
    if (import.meta.env.DEV) console.debug("[key]", `#${color.getHexString()}`, `spread ${spread.toFixed(1)}`);
    return color;
  } catch {
    return fallback;
  }
}

const FX_COLOR: Record<Fx, string> = {
  none: "#ffffff",
  fire: "#ff7a1a",
  sparkles: "#fff3a0",
  lightning: "#9ad8ff",
  smoke: "#8a8a9a",
};

function seedFrom(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return h / 100;
}

export function EntitySprite({ entity, diedAt }: { entity: EntitySpec; diedAt?: number }) {
  const group = useRef<Group>(null);
  const inner = useRef<Group>(null);
  const target = useWorldStore((s) => s.positions[entity.id]);
  const team = useWorldStore((s) => teamOfOwner(s.world, entity.ownerId));
  const seed = useMemo(() => seedFrom(entity.id), [entity.id]);
  const size = entity.size;
  const teamColor = team ? TEAM_INFO[team].color : "#ffffff";

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime + seed;
    const [tx, , tz] = target ?? [entity.position.x, 0, entity.position.z];
    const k = entity.moveStyle === "teleport" ? 1 : Math.min(1, dt * (entity.moveStyle === "slither" ? 2.5 : 5));
    g.position.x += (tx - g.position.x) * k;
    g.position.z += (tz - g.position.z) * k;

    let y = size * 0.5;
    let s = 1;
    switch (entity.idleAnim) {
      case "bob":
        y += Math.sin(t * 2.2) * 0.06 * size;
        break;
      case "float":
        y += 0.25 * size + Math.sin(t * 1.1) * 0.12 * size;
        break;
      case "pulse":
        s = 1 + Math.sin(t * 3) * 0.05;
        break;
      case "spin":
        if (inner.current) inner.current.rotation.z = Math.sin(t * 1.5) * 0.25;
        break;
    }
    if (entity.moveStyle === "hover") y += Math.sin(t * 1.7) * 0.05 * size;
    g.position.y = y;
    g.scale.setScalar(s);
  });

  const hp = Math.max(0, Math.min(1, entity.hp / Math.max(1, entity.maxHp)));

  return (
    <group ref={group} position={[entity.position.x, size * 0.5, entity.position.z]}>
      {entity.heart ? (
        team ? (
          <Heart3D entity={entity} team={team} />
        ) : (
          <Heart entity={entity} />
        )
      ) : (
        <Billboard>
          <group ref={inner}>
            {entity.imageUrl ? (
              <Suspense fallback={<Placeholder entity={entity} />}>
                <Sprite url={withBase(entity.imageUrl)} entity={entity} diedAt={diedAt} />
              </Suspense>
            ) : (
              <Placeholder entity={entity} />
            )}
          </group>
        </Billboard>
      )}
      {!diedAt && (
        <Html position={[0, size * 0.62, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
          <div className="label">
            <div className="label-name" style={{ color: teamColor }}>
              {entity.label}
              {entity.kills ? <span className="label-stars"> {"★".repeat(Math.min(3, entity.kills))}</span> : null}
            </div>
            <div className="label-hp">
              <i style={{ width: `${hp * 100}%`, background: hp > 0.5 ? "#7cf2a0" : hp > 0.2 ? "#ffd166" : "#ff5d5d" }} />
            </div>
          </div>
        </Html>
      )}
      {entity.fx !== "none" && (
        <Sparkles
          count={Math.round(10 + size * 6)}
          scale={[size * 0.9, size * 1.1, size * 0.9]}
          size={entity.fx === "smoke" ? 9 : entity.fx === "lightning" ? 2.5 : 4}
          speed={entity.fx === "lightning" ? 3 : entity.fx === "smoke" ? 0.3 : 0.8}
          color={FX_COLOR[entity.fx]}
          opacity={entity.fx === "smoke" ? 0.35 : 0.9}
          position={[0, 0, 0]}
        />
      )}
    </group>
  );
}

/**
 * Crystal stand-in for a heart whose team is not known yet (snapshot still loading); Heart3D takes
 * over as soon as the owner resolves to a team.
 */
function Heart({ entity, children }: { entity: EntitySpec; children?: ReactNode }) {
  const beatGroup = useRef<Group>(null);
  const crystal = useRef<Group>(null);
  const r = entity.size * 0.3;
  const hp = entity.hp / Math.max(1, entity.maxHp);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const beat = 1 + Math.max(0, Math.sin(t * (2.2 + (1 - hp) * 3))) ** 6 * 0.1;
    beatGroup.current?.scale.setScalar(beat);
    if (crystal.current) crystal.current.rotation.y = t * 0.4;
  });
  return (
    <group>
      <group ref={beatGroup}>
        {children ?? (
          <group ref={crystal}>
            <mesh>
              <octahedronGeometry args={[r, 0]} />
              <meshStandardMaterial color={entity.placeholderColor} emissive={entity.placeholderColor} emissiveIntensity={1.6} transparent opacity={0.92} />
            </mesh>
            <mesh rotation={[0.3, 0.8, 0]}>
              <octahedronGeometry args={[r * 1.35, 1]} />
              <meshBasicMaterial color={entity.placeholderColor} wireframe transparent opacity={0.35} />
            </mesh>
          </group>
        )}
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -entity.size * 0.5 + 0.02, 0]}>
        <ringGeometry args={[entity.size * 0.45, entity.size * 0.55, 48]} />
        <meshBasicMaterial color={entity.placeholderColor} transparent opacity={0.5} />
      </mesh>
    </group>
  );
}

function Placeholder({ entity }: { entity: EntitySpec }) {
  const r = entity.size * 0.32;
  return (
    <group>
      <mesh>
        <sphereGeometry args={[r, 24, 24]} />
        <meshStandardMaterial
          color={entity.placeholderColor}
          emissive={entity.placeholderColor}
          emissiveIntensity={1.4}
          transparent
          opacity={0.75}
        />
      </mesh>
      <mesh rotation={[0.6, 0.4, 0]}>
        <icosahedronGeometry args={[r * 1.35, 1]} />
        <meshBasicMaterial color={entity.placeholderColor} wireframe transparent opacity={0.5} />
      </mesh>
    </group>
  );
}

function Sprite({ url, entity, diedAt }: { url: string; entity: EntitySpec; diedAt?: number }) {
  const texture = useTexture(url) as Texture;
  const hitAt = useWorldStore((s) => s.hits[entity.id]);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          map: { value: texture },
          keyColor: { value: sampleKeyColor(texture) },
          texel: { value: texelSize(texture) },
          flash: { value: 0 },
          dissolve: { value: 0 },
        },
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    [texture],
  );

  useFrame(() => {
    const now = Date.now();
    material.uniforms.flash!.value = hitAt ? Math.max(0, 1 - (now - hitAt) / 350) : 0;
    material.uniforms.dissolve!.value = diedAt ? Math.min(1, (now - diedAt) / 1300) : 0;
  });

  const s = entity.size;
  return (
    <mesh material={material} position={[0, 0, 0]}>
      <planeGeometry args={[s, s]} />
    </mesh>
  );
}
