import { readFileSync, writeFileSync } from "node:fs";
import type { AudioFrame } from "@livekit/rtc-node";

export interface Pcm {
  sampleRate: number;
  channels: 1;
  samples: Int16Array;
}

/** Parse a 16-bit PCM RIFF WAV (mono or stereo) into mono samples. */
export function readWav(path: string): Pcm {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path}: not a WAV`);
  let off = 12;
  let fmt: { channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === "fmt ") {
      const format = body.readUInt16LE(0);
      if (format !== 1) throw new Error(`${path}: only PCM WAV supported (format ${format})`);
      fmt = { channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === "data") {
      data = body;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt or data chunk`);
  if (fmt.bits !== 16) throw new Error(`${path}: only 16-bit WAV supported`);
  const interleaved = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  if (fmt.channels === 1) return { sampleRate: fmt.rate, channels: 1, samples: interleaved };
  const mono = new Int16Array(Math.floor(interleaved.length / fmt.channels));
  for (let i = 0; i < mono.length; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += interleaved[i * fmt.channels + c]!;
    mono[i] = Math.round(acc / fmt.channels);
  }
  return { sampleRate: fmt.rate, channels: 1, samples: mono };
}

export function writeWav(path: string, samples: Int16Array, sampleRate: number): void {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(samples.buffer, samples.byteOffset, dataBytes).copy(buf, 44);
  writeFileSync(path, buf);
}

/** A plain sine tone: enough to prove audio crosses a subscription without any TTS. */
export function tone(seconds: number, sampleRate = 16000, freq = 440, amplitude = 8000): Pcm {
  const n = Math.round(seconds * sampleRate);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude);
  return { sampleRate, channels: 1, samples };
}

/** Concatenate clips with silence gaps (seconds) into one mono buffer at the first clip's rate. */
export function concatWithGaps(clips: Pcm[], gapSeconds: number, leadSeconds = 1): Pcm {
  const rate = clips[0]?.sampleRate ?? 16000;
  const gap = Math.round(gapSeconds * rate);
  const lead = Math.round(leadSeconds * rate);
  const total = lead + clips.reduce((n, c) => n + c.samples.length + gap, 0);
  const out = new Int16Array(total);
  let pos = lead;
  for (const c of clips) {
    if (c.sampleRate !== rate) throw new Error("concatWithGaps: mixed sample rates");
    out.set(c.samples, pos);
    pos += c.samples.length + gap;
  }
  return { sampleRate: rate, channels: 1, samples: out };
}

/** Collects frames from a subscribed remote audio track so a run can prove audio actually arrived. */
export class Recorder {
  frames = 0;
  samples: Int16Array[] = [];
  constructor(readonly sampleRate = 16000) {}
  push(frame: AudioFrame): void {
    this.frames++;
    if (this.samples.length < 50_000) this.samples.push(Int16Array.from(frame.data));
  }
  save(path: string): number {
    const total = this.samples.reduce((n, s) => n + s.length, 0);
    const out = new Int16Array(total);
    let pos = 0;
    for (const s of this.samples) {
      out.set(s, pos);
      pos += s.length;
    }
    writeWav(path, out, this.sampleRate);
    return total / this.sampleRate;
  }
}
