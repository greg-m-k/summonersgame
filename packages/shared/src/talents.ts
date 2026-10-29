import { z } from "zod";

export const Branch = z.enum(["fury", "hide", "dream"]);
export type Branch = z.infer<typeof Branch>;

export const BRANCH_INFO: Record<Branch, { name: string; blurb: string; color: string }> = {
  fury: { name: "Fury", blurb: "Your things hit harder.", color: "#ff5d5d" },
  hide: { name: "Hide", blurb: "Your things last longer.", color: "#7cf2a0" },
  dream: { name: "Dream", blurb: "More of everything, faster.", color: "#c084fc" },
};

export interface Talent {
  id: string;
  branch: Branch;
  tier: 1 | 2 | 3;
  name: string;
  /** One line, shown in the tree and read by demons. */
  text: string;
}

/** Three branches, three tiers. Tier N needs a tier N-1 pick in the same branch. One talent point each. */
export const TALENTS: readonly Talent[] = [
  { id: "sharp_teeth", branch: "fury", tier: 1, name: "Sharp Teeth", text: "+20% attack on everything you summon" },
  { id: "bloodlust", branch: "fury", tier: 2, name: "Bloodlust", text: "+30% damage while the attacker is under half hp" },
  { id: "overkill", branch: "fury", tier: 3, name: "Overkill", text: "+60% damage to hearts" },
  { id: "thick_hide", branch: "hide", tier: 1, name: "Thick Hide", text: "+25% hp on everything you summon" },
  { id: "regrowth", branch: "hide", tier: 2, name: "Regrowth", text: "creatures heal 3% hp per second when nothing is in reach" },
  { id: "second_wind", branch: "hide", tier: 3, name: "Second Wind", text: "each creature survives its first death at 1 hp" },
  { id: "silver_tongue", branch: "dream", tier: 1, name: "Silver Tongue", text: "every point pays 2 extra mic seconds" },
  { id: "echo", branch: "dream", tier: 2, name: "Echo", text: "every summon brings an echo, a 40% copy of itself" },
  { id: "haste", branch: "dream", tier: 3, name: "Haste", text: "+30% speed on everything you summon" },
];

export const TALENT_BY_ID: Record<string, Talent> = Object.fromEntries(TALENTS.map((t) => [t.id, t]));

/** Why a talent cannot be taken right now, or null when it can. */
export function talentBlocker(id: string, owned: readonly string[], talentPoints: number): string | null {
  const t = TALENT_BY_ID[id];
  if (!t) return "no such talent";
  if (owned.includes(id)) return "already taken";
  if (t.tier > 1 && !owned.some((o) => TALENT_BY_ID[o]?.branch === t.branch && TALENT_BY_ID[o]?.tier === t.tier - 1)) {
    return `needs a tier ${t.tier - 1} ${BRANCH_INFO[t.branch].name} talent first`;
  }
  if (talentPoints <= 0) return "no talent points";
  return null;
}

export const XP_PER_POINT = 10;
/** Mic seconds granted on every level. */
export const LEVEL_UP_MIC_SECONDS = 20;

/** XP needed to go from `level` to `level + 1`: 100, 150, 200, ... */
export const xpToNext = (level: number): number => 100 + 50 * (level - 1);

/** Total XP at which `level` is reached (level 1 at 0). */
export function xpAtLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += xpToNext(l);
  return total;
}

export function levelForXp(xp: number): number {
  let level = 1;
  while (xp >= xpAtLevel(level + 1)) level++;
  return level;
}
