import { useParticipants, useRoomContext } from "@livekit/components-react";
import { TOPIC_CHAT } from "@summoners/shared";
import { useEffect, useRef, useState } from "react";
import type { Session } from "../api.ts";
import { useWorldStore } from "../world/useWorldStore.ts";
import { SECRET, TYPED, useChatStore, useTranscripts } from "./useTranscripts.ts";

/**
 * Subtitles for the conversation with your own demon (what it said, what it heard you say) and a
 * text box that reaches the demon through the agents framework's chat topic. Typing is the only
 * way to be understood when no speech-to-text key is configured.
 */
export function DemonChat({ session }: { session: Session }) {
  useTranscripts();
  const room = useRoomContext();
  const participants = useParticipants();
  const me = useWorldStore((s) => s.world.players[session.identity]);
  const demonId = me?.demonIdentity ?? null;
  const demon =
    participants.find((p) => p.identity === demonId) ?? participants.find((p) => p.attributes?.demon_for === session.identity);
  const mocks = demon?.attributes?.mocks ? demon.attributes.mocks.split(",").filter(Boolean) : [];
  const lines = useChatStore((s) => s.lines);
  const upsert = useChatStore((s) => s.upsert);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const mine = lines
    .filter(
      (l) =>
        l.identity === session.identity || l.identity === TYPED || l.identity === SECRET || (demon ? l.identity === demon.identity : false),
    )
    .slice(-6);
  const lastText = mine.at(-1)?.text;
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [mine.length, lastText]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    upsert({ id: `typed-${Date.now()}`, identity: TYPED, text, final: true, at: Date.now() });
    try {
      await room.localParticipant.sendText(text, { topic: TOPIC_CHAT });
    } catch (err) {
      console.warn("could not send chat text", err);
    }
  };

  const title = demon?.attributes?.persona ?? me?.persona ?? "your demon";
  return (
    <div className="demon-chat">
      <div className="demon-chat-title">
        <span>{demon ? title : `${title} (summoning...)`}</span>
        {mocks.length > 0 && (
          <span className="demon-chat-mock" title={`no API key, running on a mock: ${mocks.join(", ")}`}>
            mock {mocks.join("/")}
          </span>
        )}
      </div>
      <div className="demon-chat-lines" ref={listRef}>
        {mine.map((l) => (
          <div
            key={l.id}
            className={`demon-chat-line ${l.identity === SECRET ? "secret" : demon && l.identity === demon.identity ? "demon" : "me"}${l.final ? "" : " partial"}`}
          >
            {l.text}
          </div>
        ))}
      </div>
      <input
        className="demon-chat-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={mocks.includes("stt") ? "No DEEPGRAM_API_KEY: demon can't hear words, type them here" : "Whisper to your demon (or just talk)"}
        disabled={!demon}
        aria-label="Whisper to your demon"
      />
    </div>
  );
}
