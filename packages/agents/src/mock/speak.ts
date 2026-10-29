import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Output rate of the mock voice; matches the agents framework's default room output. */
export const SAMPLE_RATE = 24_000;
const CACHE_DIR = resolve(tmpdir(), "summoners-tts");
const SAPI_VOICES = ["Microsoft David Desktop", "Microsoft Zira Desktop"];

export interface MockVoice {
  /** Persona name, for logs. */
  name: string;
  /** Picks one of the system voices. */
  index: number;
  /** SAPI speaking rate, -10..10. */
  rate: number;
}

/** A stable voice per persona so two demons in a room do not sound identical. */
export function voiceFor(persona: string): MockVoice {
  let h = 7;
  for (const c of persona) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { name: persona, index: h % SAPI_VOICES.length, rate: (h % 5) - 2 };
}

/**
 * Text to 24 kHz mono 16-bit PCM without any API key: the Windows speech API when available,
 * otherwise synthetic bleeps shaped by the words, so audio still flows through the pipeline.
 */
export async function speak(text: string, voice: MockVoice): Promise<Int16Array> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!clean) return new Int16Array(0);
  if (process.platform === "win32") {
    try {
      return await sapi(clean, voice);
    } catch (err) {
      console.warn("[mock tts] SAPI failed, using bleeps:", err instanceof Error ? err.message : err);
    }
  }
  return bleeps(clean, voice);
}

async function sapi(text: string, voice: MockVoice): Promise<Int16Array> {
  const sysVoice = SAPI_VOICES[voice.index % SAPI_VOICES.length]!;
  const id = createHash("sha1").update(`${sysVoice}|${voice.rate}|${text}`).digest("hex").slice(0, 16);
  const out = resolve(CACHE_DIR, `${id}.wav`);
  if (!existsSync(out)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const req = { voice: sysVoice, rate: voice.rate, out, text };
    try {
      await SapiServer.get().synth(req);
    } catch (err) {
      // The long-lived process died or never started; pay the ~1 s spawn cost for this one request.
      console.warn("[mock tts] SAPI server unavailable, spawning once:", err instanceof Error ? err.message : err);
      await sapiOnce(req);
    }
  }
  const wav = readWav(readFileSync(out));
  return resample(wav.samples, wav.sampleRate, SAMPLE_RATE);
}

interface SapiRequest {
  voice: string;
  rate: number;
  out: string;
  text: string;
}

const SAPI_SERVER_SCRIPT = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $req = $line | ConvertFrom-Json
    try { $s.SelectVoice($req.voice) } catch {}
    $s.Rate = [int]$req.rate
    $s.SetOutputToWaveFile($req.out, $fmt)
    $s.Speak($req.text)
    $s.SetOutputToNull()
    [Console]::Out.WriteLine("ok")
  } catch {
    try { $s.SetOutputToNull() } catch {}
    [Console]::Out.WriteLine("err " + $_.Exception.Message)
  }
}
`;

/**
 * One PowerShell process kept alive per worker process, so a sentence costs the synthesis time
 * (about 100 to 300 ms) instead of the synthesis plus a 1 s PowerShell start. Requests are answered
 * in order, one line per request.
 */
class SapiServer {
  private static instance: SapiServer | null = null;
  private proc: ChildProcess;
  private pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private buffer = "";
  private dead: Error | null = null;

  static get(): SapiServer {
    if (!SapiServer.instance || SapiServer.instance.dead) SapiServer.instance = new SapiServer();
    return SapiServer.instance;
  }

  private constructor() {
    mkdirSync(CACHE_DIR, { recursive: true });
    const script = resolve(CACHE_DIR, "sapi-server.ps1");
    writeFileSync(script, SAPI_SERVER_SCRIPT, "utf8");
    this.proc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        const p = this.pending.shift();
        if (p) {
          if (line === "ok") p.resolve();
          else p.reject(new Error(line || "empty reply from SAPI"));
        }
        nl = this.buffer.indexOf("\n");
      }
    });
    this.proc.stderr!.on("data", (chunk: Buffer) => console.warn("[mock tts] sapi:", chunk.toString("utf8").trim().slice(0, 200)));
    const fail = (why: string) => {
      this.dead = new Error(why);
      for (const p of this.pending.splice(0)) p.reject(this.dead);
    };
    this.proc.on("error", (err) => fail(`sapi process error: ${err.message}`));
    this.proc.on("exit", (code) => fail(`sapi process exited (${code ?? "signal"})`));
    this.proc.unref();
  }

  synth(req: SapiRequest): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.proc.stdin!.write(`${JSON.stringify(req)}\n`, (err) => {
        if (err) reject(err);
      });
    });
  }
}

async function sapiOnce(req: SapiRequest): Promise<void> {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `try { $s.SelectVoice(${q(req.voice)}) } catch {}`,
    `$s.Rate = ${req.rate}`,
    "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    `$s.SetOutputToWaveFile(${q(req.out)}, $fmt)`,
    `$s.Speak(${q(req.text)})`,
    "$s.Dispose()",
  ].join("; ");
  await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 60_000 });
}

/** Minimal RIFF reader for 16-bit PCM mono WAV. */
function readWav(buf: Buffer): { samples: Int16Array; sampleRate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let pos = 12;
  let sampleRate = 16_000;
  let channels = 1;
  let bits = 16;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`unsupported WAV bit depth ${bits}`);
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / 2 / channels);
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(body + i * channels * 2);
      return { samples, sampleRate };
    }
    pos = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

function resample(src: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return src;
  const n = Math.floor((src.length * to) / from);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * from) / to;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const f = pos - i0;
    out[i] = Math.round(src[i0]! * (1 - f) + src[i1]! * f);
  }
  return out;
}

/** One pitched tone per word, pitch from the word, length from its letters. Unmistakably fake, clearly audible. */
function bleeps(text: string, voice: MockVoice): Int16Array {
  const words = text.split(" ").filter(Boolean);
  const base = 150 + voice.index * 70;
  const perChar = Math.round(SAMPLE_RATE * 0.05 * 1.12 ** -voice.rate);
  const gap = Math.round(SAMPLE_RATE * 0.06);
  let total = 0;
  for (const w of words) total += w.length * perChar + gap;
  const out = new Int16Array(total);
  let pos = 0;
  for (const w of words) {
    let h = 3;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const f0 = base + (h % 90);
    const len = w.length * perChar;
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.min(1, i / 400, (len - i) / 800);
      const v =
        Math.sin(2 * Math.PI * f0 * t) * 0.6 + Math.sin(2 * Math.PI * f0 * 2.01 * t) * 0.25 + Math.sin(2 * Math.PI * f0 * 3.1 * t) * 0.1;
      out[pos + i] = Math.round(v * env * 9000);
    }
    pos += len + gap;
  }
  return out;
}
