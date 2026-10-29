import { type AudioBuffer, asLanguageCode, stt } from "@livekit/agents";
import { UNINTELLIGIBLE_PREFIX } from "@summoners/shared";

/**
 * Keyless speech-to-text: reports how long the player spoke, never what they said. Non-streaming,
 * so the framework wraps it in stt.StreamAdapter and the VAD decides where turns end. This keeps
 * the whole audio pipeline (VAD, turn taking, interruption, TTS playback) exercisable without a
 * provider; words reach the demon through the typed chat instead.
 */
export class MockSTT extends stt.STT {
  label = "mock.STT";

  constructor() {
    super({ streaming: false, interimResults: false });
  }

  get model(): string {
    return "duration-only";
  }

  get provider(): string {
    return "mock";
  }

  protected async _recognize(buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    const frames = Array.isArray(buffer) ? buffer : [buffer];
    let seconds = 0;
    for (const f of frames) seconds += f.samplesPerChannel / f.sampleRate;
    const text = `${UNINTELLIGIBLE_PREFIX}, ${seconds.toFixed(1)}s of speech)`;
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text, language: asLanguageCode("en"), startTime: 0, endTime: seconds, confidence: 1 }],
    };
  }

  stream(): stt.SpeechStream {
    throw new Error("MockSTT is not streaming; the framework wraps it in stt.StreamAdapter");
  }
}
