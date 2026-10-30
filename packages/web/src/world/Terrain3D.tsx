import { useFrame } from "@react-three/fiber";
import { type Lane, type Obstacle, type Terrain, mulberry32 } from "@summoners/shared";
import { useMemo, useRef } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DodecahedronGeometry, type Group, type Mesh } from "three";
import look from "./arenaLook.json";

export type ArenaLook = typeof look;

/**
 * The field a match is played on: lanes drawn as lit ribbons on the ground, and the rocks, pillars,
 * crystals, ruins and pools the engine routes creatures around. Geometry is built from the same
 * seeded terrain the server used, so what you see is exactly what blocks.
 */
export function Terrain3D({ terrain, lookOverride }: { terrain: Terrain; lookOverride?: ArenaLook }) {
  const L = lookOverride ?? look;
  return (
    <group>
      {terrain.lanes.map((lane) => (
        <LaneRibbon key={lane.id} lane={lane} L={L} />
      ))}
      {terrain.obstacles.map((o) => (
        <Piece key={o.id} o={o} L={L} seed={terrain.seed} />
      ))}
    </group>
  );
}

/** A flat strip along the lane: faint fill, brighter edges, additive so it reads as light on stone. */
function LaneRibbon({ lane, L }: { lane: Lane; L: ArenaLook }) {
  const { fill, edges } = useMemo(() => ribbonGeometry(lane, L.lane.width), [lane, L.lane.width]);
  const color = new Color(L.lane.color);
  return (
    <group position-y={0.03}>
      <mesh geometry={fill}>
        <meshBasicMaterial color={color.clone().multiplyScalar(L.lane.alpha)} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh geometry={edges}>
        <meshBasicMaterial color={color.clone().multiplyScalar(L.lane.edgeAlpha)} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

function ribbonGeometry(lane: Lane, width: number): { fill: BufferGeometry; edges: BufferGeometry } {
  const pts = lane.points;
  const half = width / 2;
  const strip = (inner: number, outer: number): BufferGeometry => {
    const verts: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const prev = pts[Math.max(0, i - 1)]!;
      const next = pts[Math.min(pts.length - 1, i + 1)]!;
      let nx = -(next.z - prev.z);
      let nz = next.x - prev.x;
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      for (const side of [-1, 1]) {
        verts.push(p.x + nx * outer * side, 0, p.z + nz * outer * side);
        verts.push(p.x + nx * inner * side, 0, p.z + nz * inner * side);
      }
    }
    // 4 vertices per point: [-outer, -inner, +outer, +inner]; two quads per segment (one per edge band).
    for (let i = 0; i < pts.length - 1; i++) {
      const a = i * 4;
      const b = a + 4;
      for (const [o, n] of [
        [0, 1],
        [2, 3],
      ] as const) {
        idx.push(a + o, b + o, a + n, a + n, b + o, b + n);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(verts), 3));
    g.setIndex(idx);
    return g;
  };
  // The fill is one band from -half to +half: inner 0 on both sides would collapse, so build it as
  // two bands that meet in the middle.
  return { fill: strip(0.001, half), edges: strip(half, half + 0.22) };
}

/** One obstacle, picked by kind; shapes are jittered by the seed so no two rocks match. */
function Piece({ o, L, seed }: { o: Obstacle; L: ArenaLook; seed: number }) {
  const rnd = useMemo(() => mulberry32(seed * 31 + Number(o.id.slice(2)) * 7), [seed, o.id]);
  switch (o.kind) {
    case "rock":
      return <Rock o={o} L={L} rnd={rnd} />;
    case "pillar":
      return <Pillar o={o} L={L} />;
    case "crystal":
      return <Crystal o={o} L={L} rnd={rnd} />;
    case "ruin":
      return <Ruin o={o} L={L} rnd={rnd} />;
    case "pool":
      return <Pool o={o} L={L} />;
  }
}

function Rock({ o, L, rnd }: { o: Obstacle; L: ArenaLook; rnd: () => number }) {
  const geometry = useMemo(() => {
    // The dodecahedron is unindexed (faces do not share vertices), so the bump must be a function of
    // position, not of vertex index, or the faces tear apart into crumpled paper.
    const g = new DodecahedronGeometry(1, 1);
    const pos = g.attributes.position!;
    const salt = rnd() * 100;
    const bump = (x: number, y: number, z: number): number => {
      const n = Math.sin(x * 4.1 + salt) * Math.cos(y * 3.7 - salt) + Math.sin(z * 5.3 + y * 2.1 + salt * 0.5);
      return 0.82 + (n * 0.5 + 0.5) * 0.4;
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const k = bump(x, y, z);
      pos.setXYZ(i, x * k, y * k * 0.72, z * k);
    }
    g.computeVertexNormals();
    return g;
  }, [rnd]);
  return (
    <mesh geometry={geometry} position={[o.x, o.h * 0.35, o.z]} rotation={[0, o.rot, 0]} scale={[o.r, o.h, o.r]} castShadow receiveShadow>
      <meshStandardMaterial color={L.rock.color} roughness={L.rock.roughness} flatShading emissive={L.rock.emissive} emissiveIntensity={L.rock.emissiveIntensity} />
    </mesh>
  );
}

function Pillar({ o, L }: { o: Obstacle; L: ArenaLook }) {
  const cap = useRef<Mesh>(null);
  useFrame((s) => {
    if (cap.current) cap.current.position.y = o.h + 0.5 + Math.sin(s.clock.elapsedTime * 1.3 + o.x) * 0.12;
  });
  return (
    <group position={[o.x, 0, o.z]} rotation={[0, o.rot, 0]}>
      <mesh position-y={o.h / 2} castShadow>
        <cylinderGeometry args={[o.r * 0.7, o.r, o.h, 7]} />
        <meshStandardMaterial color={L.pillar.color} roughness={L.pillar.roughness} flatShading />
      </mesh>
      <mesh ref={cap} position-y={o.h + 0.5}>
        <octahedronGeometry args={[o.r * 0.55, 0]} />
        <meshStandardMaterial color={L.pillar.capColor} emissive={L.pillar.capColor} emissiveIntensity={L.pillar.capIntensity} />
      </mesh>
    </group>
  );
}

function Crystal({ o, L, rnd }: { o: Obstacle; L: ArenaLook; rnd: () => number }) {
  const group = useRef<Group>(null);
  const shards = useMemo(
    () =>
      Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => ({
        x: (rnd() - 0.5) * o.r * 1.2,
        z: (rnd() - 0.5) * o.r * 1.2,
        h: o.h * (0.5 + rnd() * 0.7),
        r: o.r * (0.25 + rnd() * 0.3),
        tilt: (rnd() - 0.5) * 0.5,
        yaw: rnd() * Math.PI,
      })),
    [rnd, o.r, o.h],
  );
  useFrame((s) => {
    if (!group.current) return;
    const k = 0.85 + Math.sin(s.clock.elapsedTime * 2 + o.z) * 0.15;
    for (const m of group.current.children) {
      // The group also holds the point light, which has no material.
      const mat = (m as Mesh).material as { emissiveIntensity?: number } | undefined;
      if (mat && mat.emissiveIntensity !== undefined) mat.emissiveIntensity = L.crystal.emissiveIntensity * k;
    }
  });
  return (
    <group ref={group} position={[o.x, 0, o.z]} rotation={[0, o.rot, 0]}>
      {shards.map((sh, i) => (
        <mesh key={i} position={[sh.x, sh.h * 0.45, sh.z]} rotation={[sh.tilt, sh.yaw, sh.tilt * 0.6]}>
          <coneGeometry args={[sh.r, sh.h, 5]} />
          <meshStandardMaterial
            color={L.crystal.color}
            emissive={L.crystal.emissive}
            emissiveIntensity={L.crystal.emissiveIntensity}
            transparent
            opacity={L.crystal.opacity}
            roughness={0.2}
            flatShading
          />
        </mesh>
      ))}
      <pointLight color={L.crystal.emissive} intensity={6} distance={7} decay={2} position-y={o.h * 0.5} />
    </group>
  );
}

function Ruin({ o, L, rnd }: { o: Obstacle; L: ArenaLook; rnd: () => number }) {
  const blocks = useMemo(
    () =>
      Array.from({ length: 4 + Math.floor(rnd() * 3) }, (_, i) => ({
        x: (rnd() - 0.5) * o.r * 1.3,
        z: (rnd() - 0.5) * o.r * 1.3,
        w: o.r * (0.35 + rnd() * 0.4),
        h: o.h * (0.3 + rnd() * 0.8),
        d: o.r * (0.3 + rnd() * 0.4),
        yaw: rnd() * 0.8 + i,
        lean: (rnd() - 0.5) * 0.25,
      })),
    [rnd, o.r, o.h],
  );
  return (
    <group position={[o.x, 0, o.z]} rotation={[0, o.rot, 0]}>
      {blocks.map((b, i) => (
        <mesh key={i} position={[b.x, b.h / 2, b.z]} rotation={[b.lean, b.yaw, 0]} castShadow receiveShadow>
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial color={L.ruin.color} roughness={L.ruin.roughness} />
        </mesh>
      ))}
    </group>
  );
}

function Pool({ o, L }: { o: Obstacle; L: ArenaLook }) {
  const disc = useRef<Mesh>(null);
  useFrame((s) => {
    const mat = disc.current?.material as { emissiveIntensity?: number } | undefined;
    if (mat) mat.emissiveIntensity = L.pool.emissiveIntensity * (0.8 + Math.sin(s.clock.elapsedTime * 0.9 + o.x) * 0.2);
  });
  return (
    <group position={[o.x, 0.02, o.z]}>
      <mesh ref={disc} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[o.r, 40]} />
        <meshStandardMaterial color={L.pool.color} emissive={L.pool.emissive} emissiveIntensity={L.pool.emissiveIntensity} roughness={0.1} metalness={0.3} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.005}>
        <ringGeometry args={[o.r, o.r + 0.25, 40]} />
        <meshBasicMaterial color={new Color(L.pool.emissive).multiplyScalar(L.pool.rimAlpha)} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}
