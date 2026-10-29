import { useRoomContext } from "@livekit/components-react";
import { useEffect } from "react";
import { create } from "zustand";

export interface ChatLine {
  /** Segment id from the agent, or a local id for typed lines. */
  id: string;
  /** Participant the line is attributed to: the demon, the player (what the demon heard), or "typed". */
  identity: string;
  text: string;
  final: boolean;
  at: number;
}

interface ChatStore {
  lines: ChatLine[];
  upsert: (line: ChatLine) => void;
}

const MAX_LINES = 40;
export const TYPED = "typed";
/** Lines from the server meant for this player alone (bribes). */
export const SECRET = "secret";

export const useChatStore = create<ChatStore>((set) => ({
  lines: [],
  upsert: (line) =>
    set((s) => {
      const i = s.lines.findIndex((l) => l.id === line.id);
      const lines = i >= 0 ? s.lines.map((l, j) => (j === i ? line : l)) : [...s.lines, line].slice(-MAX_LINES);
      return { lines };
    }),
}));

/**
 * Mirrors the agents framework's lk.transcription text streams into the chat store, keyed by segment
 * so partial text is replaced in place. A demon's own speech is one delta stream per segment that
 * closes when playout ends; what it heard arrives as interim streams plus a final one.
 */
export function useTranscripts(): void {
  const room = useRoomContext();
  useEffect(() => {
    const upsert = useChatStore.getState().upsert;
    try {
      room.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
        const attrs = reader.info.attributes ?? {};
        const id = attrs["lk.segment_id"] ?? reader.info.id;
        let text = "";
        for await (const chunk of reader) {
          text += chunk;
          if (text.trim()) upsert({ id, identity: participant.identity, text, final: false, at: Date.now() });
        }
        if (text.trim()) upsert({ id, identity: participant.identity, text, final: true, at: Date.now() });
      });
    } catch (err) {
      console.warn("transcription handler not registered", err);
    }
    if (import.meta.env.DEV) (window as unknown as { __chat: typeof useChatStore }).__chat = useChatStore;
    return () => room.unregisterTextStreamHandler("lk.transcription");
  }, [room]);
}
