export interface Entry {
  /** ms since the run started */
  t: number;
  kind: string;
  actor?: string;
  text: string;
  data?: unknown;
}

/** One ordered log of everything the harness did and saw, shared by all bots in a run. */
export class Timeline {
  readonly entries: Entry[] = [];
  readonly startedAt = Date.now();
  private listeners = new Set<(e: Entry) => void>();

  add(kind: string, text: string, actor?: string, data?: unknown): Entry {
    const e: Entry = { t: Date.now() - this.startedAt, kind, actor, text, data };
    this.entries.push(e);
    const stamp = `${(e.t / 1000).toFixed(1).padStart(6)}s`;
    const who = actor ? ` ${actor}:` : "";
    console.log(`${stamp} [${kind}]${who} ${text}`);
    for (const l of this.listeners) l(e);
    return e;
  }

  on(fn: (e: Entry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve when an entry matching the predicate arrives (or already exists after `since`). */
  waitFor(pred: (e: Entry) => boolean, timeoutMs: number, since = 0): Promise<Entry | null> {
    const existing = this.entries.find((e) => e.t >= since && pred(e));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
      const off = this.on((e) => {
        if (pred(e)) {
          clearTimeout(timer);
          off();
          resolve(e);
        }
      });
    });
  }

  now(): number {
    return Date.now() - this.startedAt;
  }

  /** Compact text of the last N entries for a model to read. */
  recent(n = 40, kinds?: string[]): string {
    return this.entries
      .filter((e) => !kinds || kinds.includes(e.kind))
      .slice(-n)
      .map((e) => `${(e.t / 1000).toFixed(1)}s [${e.kind}]${e.actor ? ` ${e.actor}:` : ""} ${e.text}`)
      .join("\n");
  }
}
