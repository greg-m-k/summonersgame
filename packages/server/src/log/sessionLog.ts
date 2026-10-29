import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LogEvent {
  ts: number;
  kind: string;
  data: unknown;
}

const FLUSH_MS = 5000;
const FLUSH_AT = 200;
const LOCAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../logs");

/**
 * Everything that happens in a room, batched and shipped every few seconds: to the Worker's
 * /_ops/log route (D1) when LOG_SINK_URL is set, else appended to packages/server/logs/<room>.jsonl.
 * Rooms live in memory and containers sleep; this is the only record that outlives a session.
 */
export class SessionLog {
  private queue: LogEvent[] = [];
  private timer: ReturnType<typeof setInterval>;
  private inflight = false;

  constructor(
    private room: string,
    private sink: { url?: string; secret: string },
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  add(kind: string, data: unknown): void {
    this.queue.push({ ts: Date.now(), kind, data });
    if (this.queue.length >= FLUSH_AT) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.inflight || !this.queue.length) return;
    this.inflight = true;
    const batch = this.queue.splice(0);
    try {
      if (this.sink.url) {
        const res = await fetch(this.sink.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-game-secret": this.sink.secret },
          body: JSON.stringify({ room: this.room, events: batch }),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
      } else {
        mkdirSync(LOCAL_DIR, { recursive: true });
        appendFileSync(resolve(LOCAL_DIR, `${this.room}.jsonl`), `${batch.map((e) => JSON.stringify(e)).join("\n")}\n`);
      }
    } catch (err) {
      console.warn(`[log ${this.room}] flush failed, keeping ${batch.length} events:`, err instanceof Error ? err.message : err);
      this.queue.unshift(...batch.slice(-FLUSH_AT * 5));
    } finally {
      this.inflight = false;
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
