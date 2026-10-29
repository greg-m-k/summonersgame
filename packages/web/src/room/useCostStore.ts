import type { CostSummary } from "@summoners/shared";
import { create } from "zustand";

interface CostStore {
  summary: CostSummary | null;
  set: (summary: CostSummary) => void;
}

/** The server's running spend estimate for this room, pushed every couple of seconds. */
export const useCostStore = create<CostStore>((set) => ({
  summary: null,
  set: (summary) => set({ summary }),
}));

export const usd = (n: number | undefined): string => `$${(n ?? 0).toFixed(2)}`;
