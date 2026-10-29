import { fal } from "@fal-ai/client";
import { randomUUID } from "node:crypto";
import type { EntitySpec } from "@summoners/shared";
import { stickerSvg } from "./sticker.ts";

export interface StoredImage {
  bytes: Buffer;
  contentType: string;
}

export type ImageMode = "fal" | "mock";

const STYLE =
  "sticker illustration, single subject centered, full body visible, dramatic rim light, painterly dreamlike detail, isolated on a flat uniform solid magenta #ff00ff chroma-key background, no floor, no shadow, no pink or magenta on the subject, no text, no watermark";

/**
 * Generates summon sprites with fal.ai flux/schnell and keeps the bytes in memory so the
 * client can load them same-origin from /api/img/:id. Bounded concurrency, LRU-capped cache.
 * Without FAL_KEY it draws deterministic SVG stickers instead, after a short fake delay, so the
 * placeholder-then-picture flow is the same either way.
 */
export class ImageService {
  readonly mode: ImageMode;
  private cache = new Map<string, StoredImage>();
  private inflight = 0;
  private queue: Array<() => void> = [];
  private maxConcurrent: number;
  private maxCached: number;

  private onUsage: ((entity: EntitySpec) => void) | undefined;

  constructor(
    private onImage: (entityId: string, url: string) => void,
    opts: { falKey?: string; maxConcurrent?: number; maxCached?: number; onUsage?: (entity: EntitySpec) => void } = {},
  ) {
    this.mode = opts.falKey ? "fal" : "mock";
    this.onUsage = opts.onUsage;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.maxCached = opts.maxCached ?? 300;
    if (opts.falKey) fal.config({ credentials: opts.falKey });
    else console.warn("[images] FAL_KEY missing: summons get generated SVG stickers instead of AI pictures");
  }

  get(id: string): StoredImage | undefined {
    return this.cache.get(id);
  }

  private pending = new Set<string>();
  /** Same prompt, same picture: hearts every match, repeated summons. */
  private byPrompt = new Map<string, string>();

  /** Fire-and-forget: renders the entity's picture and reports the proxied URL when ready. One render per entity at a time. */
  request(entity: EntitySpec): void {
    if (this.pending.has(entity.id)) return;
    const cachedUrl = this.byPrompt.get(entity.imagePrompt);
    if (cachedUrl && this.cache.has(cachedUrl.slice("/api/img/".length))) {
      this.onImage(entity.id, cachedUrl);
      return;
    }
    this.pending.add(entity.id);
    const job = this.mode === "fal" ? () => this.renderFal(entity) : () => this.renderMock(entity);
    this.enqueue(async () => {
      try {
        const img = await job();
        this.pending.delete(entity.id);
        if (this.mode === "fal") this.onUsage?.(entity);
        const id = randomUUID().replace(/-/g, "").slice(0, 16);
        this.store(id, img);
        this.byPrompt.set(entity.imagePrompt, `/api/img/${id}`);
        this.onImage(entity.id, `/api/img/${id}`);
      } catch (err) {
        this.pending.delete(entity.id);
        console.warn(`[images] ${entity.id} failed:`, err instanceof Error ? err.message : err);
      }
    });
  }

  private async renderFal(entity: EntitySpec): Promise<StoredImage> {
    const result = await fal.subscribe("fal-ai/flux/schnell", {
      input: {
        prompt: `${entity.imagePrompt}, ${STYLE}`,
        image_size: "square",
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      },
    });
    const img = (result.data as { images?: Array<{ url: string; content_type?: string }> }).images?.[0];
    if (!img?.url) throw new Error("fal returned no image");
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(`image download failed: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, contentType: img.content_type ?? res.headers.get("content-type") ?? "image/jpeg" };
  }

  private async renderMock(entity: EntitySpec): Promise<StoredImage> {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 900));
    return { bytes: Buffer.from(stickerSvg(entity), "utf8"), contentType: "image/svg+xml" };
  }

  private store(id: string, img: StoredImage): void {
    this.cache.set(id, img);
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private enqueue(job: () => Promise<void>): void {
    const run = () => {
      this.inflight++;
      void job().finally(() => {
        this.inflight--;
        const next = this.queue.shift();
        if (next) next();
      });
    };
    if (this.inflight < this.maxConcurrent) run();
    else this.queue.push(run);
  }
}
