import { useFrame } from "@react-three/fiber";
import { type EntitySpec, TEAM_INFO, type TeamId } from "@summoners/shared";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  type Group,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type PointLight,
  RepeatWrapping,
  TubeGeometry,
  Vector3,
} from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import look from "./heartLook.json";

export type HeartLook = typeof look & { pose?: number };

/**
 * A real heart, not a picture: the Taubin heart surface polygonised once with marching cubes,
 * physically based materials per team (Ash: dark iron shell with lava veins; Tide: glacial ice with
 * transmission), three vessels on top, a coloured light inside, and a pulse that quickens as the
 * heart weakens. Every number comes from heartLook.json so the judge loop can tune the look.
 */

/** Implicit heart: inside where f < 0. z is up. */
function heartField(x: number, y: number, z: number, lobe: number): number {
  const a = x * x * lobe + (9 / 4) * y * y + z * z - 1;
  return a * a * a - x * x * z * z * z - (9 / 80) * y * y * z * z * z;
}

let cachedGeometry: { key: string; geometry: BufferGeometry } | null = null;

function heartGeometry(res: number, lobe: number, thickness: number): BufferGeometry {
  const key = `${res}:${lobe}:${thickness}`;
  if (cachedGeometry?.key === key) return cachedGeometry.geometry;
  const mc = new MarchingCubes(res, new MeshStandardMaterial(), true, false, 200_000);
  mc.isolation = 0;
  const size = res;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Field domain: x and z span [-1.35, 1.35], the thin axis y spans [-0.9, 0.9]; the heart
        // stands up along the field's y, so swap: field y <- implicit z (up), field z <- implicit y.
        // Domain wide enough that even broad lobes never touch the edge (a clipped lobe is a hole).
        const px = (x / (size - 1)) * 3.4 - 1.7;
        const up = (y / (size - 1)) * 3.0 - 1.4;
        const py = (z / (size - 1)) * 2.2 - 1.1;
        const f = heartField(px, py, up, lobe);
        mc.field[z * size * size + y * size + x] = Math.max(-40, Math.min(40, -f * 40));
      }
    }
  }
  mc.update();
  const src = mc.geometry;
  const count = src.drawRange.count === Infinity ? src.attributes.position!.count : src.drawRange.count;
  const geometry = new BufferGeometry();
  for (const name of ["position", "normal", "uv"] as const) {
    const attr = src.attributes[name];
    if (!attr) continue;
    const size = attr.itemSize;
    geometry.setAttribute(name, new BufferAttribute((attr.array as Float32Array).slice(0, count * size), size));
  }
  // Spherical UVs so the vein texture wraps the whole shell instead of the planar projection
  // MarchingCubes emits (which clamps into stripes at the sides).
  const pos = geometry.attributes.position!;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    uv[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    uv[i * 2 + 1] = y * 0.5 + 0.5;
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  geometry.scale(1, 1, thickness);
  geometry.computeVertexNormals();
  // MarchingCubes works in [-1,1]^3 field space; recentre on the heart's middle.
  geometry.translate(0, 0.08, 0);
  geometry.computeBoundingSphere();
  cachedGeometry = { key, geometry };
  return geometry;
}

/** Cracks of light across a dark shell, or frost lines in ice: drawn once to a canvas. */
function veinTexture(color: string, density: number, width: number, seed: number): CanvasTexture {
  const n = 512;
  const canvas = document.createElement("canvas");
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, n, n);
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  const branches = Math.round(18 * density) + 4;
  for (let b = 0; b < branches; b++) {
    let x = rnd() * n;
    let y = rnd() * n;
    let ang = rnd() * Math.PI * 2;
    let w = width * (0.6 + rnd());
    for (let step = 0; step < 40; step++) {
      ctx.lineWidth = Math.max(0.4, w);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ang += (rnd() - 0.5) * 1.1;
      const len = 6 + rnd() * 14;
      x += Math.cos(ang) * len;
      y += Math.sin(ang) * len;
      ctx.lineTo(x, y);
      ctx.stroke();
      w *= 0.95;
      if (rnd() < 0.08) {
        // side branch
        let bx = x;
        let by = y;
        let bang = ang + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd());
        for (let k = 0; k < 12; k++) {
          ctx.lineWidth = Math.max(0.3, w * 0.6);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          bang += (rnd() - 0.5) * 0.8;
          bx += Math.cos(bang) * (4 + rnd() * 8);
          by += Math.sin(bang) * (4 + rnd() * 8);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
      }
    }
  }
  // soft glow around the lines
  ctx.globalCompositeOperation = "lighter";
  ctx.filter = "blur(6px)";
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = "none";
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function vesselCurves(count: number): CatmullRomCurve3[] {
  const out: CatmullRomCurve3[] = [];
  for (let i = 0; i < count; i++) {
    // Spread the trunks across the top of the heart, each leaning outward from its own lobe.
    const a = count === 1 ? Math.PI / 2 : (i / (count - 1)) * Math.PI * 0.9 + Math.PI * 0.05;
    const x = Math.cos(a) * 0.42;
    const z = Math.sin(a) * 0.18 - 0.05;
    const lean = Math.cos(a) * 0.35;
    out.push(
      new CatmullRomCurve3([
        new Vector3(x * 0.7, 0.45, z * 0.7),
        new Vector3(x, 0.85, z),
        new Vector3(x + lean * 0.6, 1.15, z * 1.4),
        new Vector3(x + lean, 1.4, z * 1.8),
      ]),
    );
  }
  return out;
}

export function Heart3D({ entity, team, lookOverride }: { entity: EntitySpec; team: TeamId; lookOverride?: HeartLook }) {
  const L: HeartLook = lookOverride ?? look;
  const group = useRef<Group>(null);
  const beat = useRef<Group>(null);
  const light = useRef<PointLight>(null);
  const hp = entity.hp / Math.max(1, entity.maxHp);
  const geometry = useMemo(() => heartGeometry(L.resolution, L.shape.lobe, L.shape.thickness), [L.resolution, L.shape.lobe, L.shape.thickness]);
  const style = team === "ash" ? L.ash : L.tide;

  const material = useMemo(() => {
    const veins = veinTexture(style.veins.color, style.veins.density, style.veins.width, team === "ash" ? 7 : 11);
    const m = new MeshPhysicalMaterial({
      color: new Color(style.color),
      emissive: new Color(style.emissive),
      emissiveIntensity: style.emissiveIntensity,
      emissiveMap: veins,
      bumpMap: veins,
      bumpScale: style.bumpScale,
      roughness: style.roughness,
      metalness: style.metalness,
      clearcoat: style.clearcoat,
      clearcoatRoughness: style.clearcoatRoughness,
    });
    if (team === "tide") {
      m.transmission = L.tide.transmission;
      m.ior = L.tide.ior;
      m.thickness = L.tide.thickness;
      m.attenuationColor = new Color(L.tide.attenuationColor);
      m.attenuationDistance = L.tide.attenuationDistance;
    }
    return m;
  }, [team, style, L.tide]);

  // Vessels: the body's material without the vein relief, so the tubes stay smooth cylinders.
  const vesselMaterial = useMemo(() => {
    const m = material.clone();
    m.emissiveMap = null;
    m.bumpMap = null;
    m.emissiveIntensity = style.emissiveIntensity * 0.03;
    m.color = new Color(style.color).multiplyScalar(0.6);
    m.roughness = 0.55;
    m.clearcoat = 0.3;
    return m;
  }, [material, style.color, style.emissiveIntensity]);
  const vessels = useMemo(
    () => vesselCurves(L.vessels.count).map((c, i) => new TubeGeometry(c, 32, L.vessels.radius * (i === 0 ? 1.25 : 0.85), 14, false)),
    [L.vessels.count, L.vessels.radius],
  );

  const size = entity.size * L.scale * 0.55;
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const rate = L.pulse.base + (1 - hp) * L.pulse.weakBoost;
    const pulse = Math.max(0, Math.sin(t * rate)) ** L.pulse.sharpness;
    beat.current?.scale.setScalar(size * (1 + pulse * L.pulse.amount));
    if (group.current) {
      group.current.position.y = Math.sin(t * L.float.speed) * L.float.amplitude;
      group.current.rotation.y = L.pose ?? t * L.rotateSpeed;
    }
    if (light.current) light.current.intensity = style.light.intensity * (0.7 + pulse * 0.6);
    material.emissiveIntensity = style.emissiveIntensity * (0.75 + pulse * 0.5);
  });

  // Additive and pre-scaled: a faint team glow on the floor whatever the tone mapping does to alpha.
  const ringColor = useMemo(() => new Color(TEAM_INFO[team].color).multiplyScalar(L.ring.opacity), [team, L.ring.opacity]);
  return (
    <group ref={group}>
      <group ref={beat} scale={size}>
        <mesh geometry={geometry} material={material} castShadow />
        {vessels.map((g, i) => (
          <mesh key={i} geometry={g} material={vesselMaterial} />
        ))}
        <pointLight ref={light} color={style.light.color} intensity={style.light.intensity} distance={style.light.distance} decay={2} />
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -entity.size * 0.5 + 0.02, 0]}>
        <ringGeometry args={[entity.size * L.ring.inner, entity.size * L.ring.outer, 64]} />
        <meshBasicMaterial color={ringColor} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}
