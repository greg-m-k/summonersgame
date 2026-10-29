import type { EntitySpec } from "@summoners/shared";

/**
 * Deterministic SVG "sticker" for an entity when no image provider is configured: a blobby
 * creature in the entity's placeholder colour on the same flat magenta background a real render
 * would have, so the client's chroma key treats it exactly like a generated picture.
 */
export function stickerSvg(e: EntitySpec): string {
  const rnd = mulberry(hash(e.id));
  const color = safeColor(e.placeholderColor);
  const dark = shade(color, -0.45);
  const light = shade(color, 0.35);
  const cx = 256;
  const cy = 272;
  const r = 100 + Math.min(e.size, 6) * 14;
  const parts: string[] = [];

  if (e.fx === "fire") {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 1.4)}" fill="#ff7a1a" opacity="0.5"/>`);
    parts.push(`<circle cx="${cx}" cy="${f(cy - r * 0.3)}" r="${f(r * 1.1)}" fill="#ffd166" opacity="0.4"/>`);
  }
  if (e.fx === "smoke") {
    for (let i = 0; i < 6; i++) {
      parts.push(
        `<circle cx="${f(cx + (rnd() - 0.5) * r * 2)}" cy="${f(cy - r * (0.5 + rnd() * 0.9))}" r="${f(22 + rnd() * 40)}" fill="#8a8a9a" opacity="0.55"/>`,
      );
    }
  }
  if (e.fx === "lightning") {
    const zig = [
      [cx - r * 1.1, cy - r * 1.1],
      [cx - r * 0.6, cy - r * 0.4],
      [cx - r * 0.9, cy - r * 0.1],
      [cx - r * 0.4, cy + r * 0.5],
    ]
      .map(([x, y]) => `${f(x!)},${f(y!)}`)
      .join(" ");
    parts.push(`<polyline points="${zig}" fill="none" stroke="#ffe94a" stroke-width="12" stroke-linejoin="round" stroke-linecap="round"/>`);
  }

  if (e.size > 3) {
    const horn = (sign: number) =>
      `<polygon points="${f(cx + sign * r * 0.45)},${f(cy - r * 0.55)} ${f(cx + sign * r * 0.85)},${f(cy - r * 1.45)} ${f(cx + sign * r * 0.15)},${f(cy - r * 0.8)}" fill="${dark}"/>`;
    parts.push(horn(-1), horn(1));
  }

  const n = 8 + Math.floor(rnd() * 6);
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.75 + rnd() * 0.5);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.9]);
  }
  parts.push(`<path d="${smoothPath(pts)}" fill="${color}" stroke="${dark}" stroke-width="10" stroke-linejoin="round"/>`);

  if (e.attack > 25) {
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI * (0.15 + rnd() * 0.7);
      const x = cx + Math.cos(a) * r * 0.9;
      const y = cy + Math.sin(a) * r * 0.8;
      parts.push(
        `<polygon points="${f(x - 14)},${f(y)} ${f(x + 14)},${f(y)} ${f(x + Math.cos(a) * 60)},${f(y + Math.sin(a) * 60)}" fill="${light}"/>`,
      );
    }
  }

  const eyes = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < eyes; i++) {
    const ex = cx + (i - (eyes - 1) / 2) * r * 0.45;
    const ey = cy - r * 0.2 + (rnd() - 0.5) * 20;
    const er = 18 + rnd() * 16;
    parts.push(`<circle cx="${f(ex)}" cy="${f(ey)}" r="${f(er)}" fill="#fff"/>`);
    parts.push(`<circle cx="${f(ex + 4)}" cy="${f(ey + 3)}" r="${f(er * 0.45)}" fill="#111"/>`);
  }
  parts.push(
    `<path d="M ${f(cx - r * 0.4)} ${f(cy + r * 0.35)} Q ${f(cx)} ${f(cy + r * (0.55 + rnd() * 0.3))} ${f(cx + r * 0.4)} ${f(cy + r * 0.35)}" fill="none" stroke="${dark}" stroke-width="8" stroke-linecap="round"/>`,
  );
  if (e.fx === "sparkles") {
    for (let i = 0; i < 8; i++) parts.push(star(cx + (rnd() - 0.5) * r * 2.6, cy + (rnd() - 0.5) * r * 2.2, 6 + rnd() * 10, "#fff6a8"));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#ff00ff"/>${parts.join("")}</svg>`;
}

const f = (n: number): string => n.toFixed(1);

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const toHex = (rgb: [number, number, number]): string =>
  `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;

/** Anything near the magenta key would vanish; push those colours to cyan. */
function safeColor(hex: string): string {
  const rgb = parseHex(hex) ?? [120, 200, 255];
  const [r, g, b] = rgb;
  if (r > 150 && b > 150 && g < 130) return "#5ad1ff";
  return toHex(rgb);
}

function shade(hex: string, amount: number): string {
  const rgb = parseHex(hex) ?? [128, 128, 128];
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  return toHex(rgb.map((c) => c + (t - c) * p) as [number, number, number]);
}

/** Closed smooth curve through the midpoints of a polygon (quadratic beziers). */
function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  const mid = (i: number): [number, number] => {
    const a = pts[i % n]!;
    const b = pts[(i + 1) % n]!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  let d = `M ${f(mid(0)[0])} ${f(mid(0)[1])}`;
  for (let i = 1; i <= n; i++) {
    const c = pts[i % n]!;
    const m = mid(i);
    d += ` Q ${f(c[0])} ${f(c[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return `${d} Z`;
}

function star(cx: number, cy: number, r: number, fill: string): string {
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.4;
    pts.push(`${f(cx + Math.cos(a) * rr)},${f(cy + Math.sin(a) * rr)}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="${fill}"/>`;
}
