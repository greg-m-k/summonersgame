import { randomUUID } from "node:crypto";
import { type APIConnectOptions, AudioByteStream, tts } from "@livekit/agents";
import { type MockVoice, SAMPLE_RATE, speak } from "./speak.ts";

/**
 * Keyless text-to-speech. Non-streaming: the framework wraps it in tts.StreamAdapter, which
 * sentence-splits the LLM output and calls synthesize() per sentence.
 */
export class MockTTS extends tts.TTS {
  label = "mock.TTS";

  constructor(readonly voice: MockVoice) {
    super(SAMPLE_RATE, 1, { streaming: false });
  }

  get model(): string {
    return process.platform === "win32" ? "windows-sapi" : "bleeps";
  }

  get provider(): string {
    return "mock";
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new MockChunkedStream(text, this, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error("MockTTS is not streaming; the framework wraps it in tts.StreamAdapter");
  }
}

class MockChunkedStream extends tts.ChunkedStream {
  label = "mock.ChunkedStream";

  constructor(
    text: string,
    private owner: MockTTS,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, owner, connOptions, abortSignal);
  }

  protected async run(): Promise<void> {
    const pcm = await speak(this.inputText, this.owner.voice);
    if (this.abortSignal.aborted) return;
    const requestId = randomUUID();
    const bytes = new AudioByteStream(SAMPLE_RATE, 1, SAMPLE_RATE / 50); // 20 ms frames
    const put = (frame: import("@livekit/rtc-node").AudioFrame) =>
      this.queue.put({ requestId, segmentId: requestId, frame, final: false });
    for (const frame of bytes.write(pcm.buffer)) put(frame);
    for (const frame of bytes.flush()) put(frame);
    if (!this.queue.closed) this.queue.close();
  }
}
