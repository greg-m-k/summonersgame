import {
  type CostSummary,
  DEFAULT_PRICES,
  type PriceTable,
  SERVICES,
  type Service,
  type ServiceCost,
  type UsageEvent,
  addUnits,
  emptyUnits,
  priceUsage,
  serviceOf,
} from "@summoners/shared";

const PACE_WINDOW_MS = 5 * 60_000;

type PlayerCost = { usd: number; byService: Record<Service, number> };

const zeroByService = (): Record<Service, number> => ({ gm: 0, demon: 0, stt: 0, tts: 0, image: 0 });

/**
 * Running spend for one room: every meter reading priced at list price, totalled by service and by
 * player, with a five-minute pace so a $/hour number is always on screen.
 */
export class CostLedger {
  readonly since = Date.now();
  private total = 0;
  private byService: Record<Service, ServiceCost>;
  private byPlayer = new Map<string, PlayerCost>();
  private recent: Array<{ ts: number; usd: number }> = [];

  constructor(
    readonly room: string,
    readonly prices: PriceTable = DEFAULT_PRICES,
    readonly budgetUsd: number | null = null,
  ) {
    this.byService = { gm: cost(), demon: cost(), stt: cost(), tts: cost(), image: cost() };
  }

  get totalUsd(): number {
    return this.total;
  }

  get overBudget(): boolean {
    return this.budgetUsd !== null && this.total >= this.budgetUsd;
  }

  /** Price one reading, add it to the totals, and attribute it to its player when it names one. */
  record(ev: UsageEvent): number {
    const usd = priceUsage(ev, this.prices);
    const svc = serviceOf(ev);
    this.byService[svc].usd += usd;
    addUnits(this.byService[svc].units, ev);
    this.total += usd;
    this.recent.push({ ts: ev.ts, usd });
    if (ev.playerId) this.attribute([ev.playerId], usd, svc);
    return usd;
  }

  /** Split an already-recorded amount across players (game master rounds are shared). */
  attribute(playerIds: string[], usd: number, svc: Service): void {
    const ids = playerIds.length ? playerIds : ["(nobody)"];
    const share = usd / ids.length;
    for (const id of ids) {
      let p = this.byPlayer.get(id);
      if (!p) {
        p = { usd: 0, byService: zeroByService() };
        this.byPlayer.set(id, p);
      }
      p.usd += share;
      p.byService[svc] += share;
    }
  }

  /** USD per hour over the last five minutes (or since the room started, if younger). */
  pace(now = Date.now()): number {
    const cutoff = now - PACE_WINDOW_MS;
    while (this.recent.length && this.recent[0]!.ts < cutoff) this.recent.shift();
    const window = Math.max(1000, Math.min(PACE_WINDOW_MS, now - this.since));
    const spent = this.recent.reduce((a, r) => a + r.usd, 0);
    return (spent * 3_600_000) / window;
  }

  summary(): CostSummary {
    const byPlayer: CostSummary["byPlayer"] = {};
    for (const [id, p] of this.byPlayer) byPlayer[id] = { usd: p.usd, byService: { ...p.byService } };
    const byService = {} as CostSummary["byService"];
    for (const k of SERVICES) byService[k] = { usd: this.byService[k].usd, units: { ...this.byService[k].units } };
    return {
      room: this.room,
      since: this.since,
      totalUsd: this.total,
      paceUsdPerHour: this.pace(),
      byService,
      byPlayer,
      budgetUsd: this.budgetUsd,
      overBudget: this.overBudget,
    };
  }
}

const cost = (): ServiceCost => ({ usd: 0, units: emptyUnits() });
