import { AudioFrame, AudioSource } from "@livekit/rtc-node";
import type { Pcm } from "./audio.ts";

/**
 * A microphone fed from the harness. Frames go straight into the AudioSource, which paces itself
 * (captureFrame blocks once its queue holds `queueSizeMs` of audio) so LiveKit sees real-time audio.
 * The track is silent between clips, like a muted human.
 */
export class FakeMic {
  readonly source: AudioSource;
  readonly frameSamples: number;
  private busy: Promise<void> = Promise.resolve();

  constructor(readonly sampleRate = 16000) {
    this.source = new AudioSource(sampleRate, 1, 200);
    this.frameSamples = Math.round(sampleRate / 50); // 20 ms
  }

  /** Queue a clip; resolves once it has fully played out. Clips are serialized. */
  play(pcm: Pcm): Promise<void> {
    if (pcm.sampleRate !== this.sampleRate) throw new Error(`FakeMic: clip is ${pcm.sampleRate} Hz, mic is ${this.sampleRate} Hz`);
    const run = async () => {
      for (let i = 0; i < pcm.samples.length; i += this.frameSamples) {
        const frame = new Int16Array(this.frameSamples);
        frame.set(pcm.samples.subarray(i, Math.min(i + this.frameSamples, pcm.samples.length)));
        await this.source.captureFrame(new AudioFrame(frame, this.sampleRate, 1, this.frameSamples));
      }
      await this.source.waitForPlayout();
    };
    this.busy = this.busy.then(run, run);
    return this.busy;
  }

  async stop(): Promise<void> {
    await this.busy.catch(() => {});
    await this.source.close();
  }
}
