import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(here, "../fixtures/tts");

/** Windows voices alternate between players so demons hear distinct speakers. */
export const VOICES = ["Microsoft David Desktop", "Microsoft Zira Desktop"];

/**
 * Offline text-to-speech to a 16 kHz mono 16-bit WAV using the Windows speech API, cached by
 * content hash. On other platforms this throws; drop pre-made WAVs into fixtures/tts instead.
 */
export function synthesize(text: string, voiceIndex = 0): string {
  const voice = VOICES[voiceIndex % VOICES.length]!;
  const id = createHash("sha1").update(`${voice}|${text}`).digest("hex").slice(0, 16);
  const out = resolve(CACHE_DIR, `${id}.wav`);
  if (existsSync(out)) return out;
  if (process.platform !== "win32") {
    throw new Error("Offline TTS is implemented with Windows SAPI only; provide WAV fixtures or run on Windows.");
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `try { $s.SelectVoice('${voice}') } catch {}`,
    "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    `$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}', $fmt)`,
    `$s.Speak('${text.replace(/'/g, "''")}')`,
    "$s.Dispose()",
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "pipe", timeout: 60_000 });
  return out;
}
