import { LiveKitRoom, RoomAudioRenderer, useRoomContext } from "@livekit/components-react";
import { DisconnectReason } from "livekit-client";
import { useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type Session, clearSession, loadSession } from "../api.ts";
import { Feed } from "../hud/Feed.tsx";
import { MatchBanner } from "../hud/MatchBanner.tsx";
import { Scoreboard } from "../hud/Scoreboard.tsx";
import { Talents } from "../hud/Talents.tsx";
import { WorldCanvas } from "../world/WorldCanvas.tsx";
import { useWorldStore } from "../world/useWorldStore.ts";
import { DemonChat } from "./DemonChat.tsx";
import { RoomMicButton } from "./RoomMicButton.tsx";
import { VideoGrid } from "./VideoGrid.tsx";
import { useSubscriptions } from "./useSubscriptions.ts";
import { useWorldSync } from "./useWorldSync.ts";

export function RoomView() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const session = useMemo(() => loadSession(code), [code]);

  useEffect(() => {
    if (!session) navigate(`/?room=${encodeURIComponent(code)}`, { replace: true });
  }, [session, code, navigate]);

  if (!session) return null;

  return (
    <LiveKitRoom
      serverUrl={session.url}
      token={session.token}
      connect
      audio
      video
      connectOptions={{ autoSubscribe: false }}
      onDisconnected={(reason) => {
        // Unmount and page refresh disconnect as CLIENT_INITIATED; keep the session so a refresh rejoins.
        if (reason === undefined || reason === DisconnectReason.CLIENT_INITIATED) return;
        console.warn("disconnected from room", DisconnectReason[reason]);
        clearSession();
        navigate(`/?room=${encodeURIComponent(code)}`);
      }}
      onError={(err) => console.error("livekit error", err)}
      className="room"
      data-lk-theme="default"
    >
      <RoomInner session={session} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function RoomInner({ session }: { session: Session }) {
  useWorldSync();
  const room = useRoomContext();
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __room: typeof room }).__room = room;
  }, [room]);
  // Stable string key so zustand does not re-render on every unrelated store change.
  const onMicKey = useWorldStore((s) =>
    Object.values(s.world.players)
      .filter((p) => p.onRoomMic && p.identity !== session.identity)
      .map((p) => p.identity)
      .sort()
      .join(","),
  );
  const onMic = useMemo(() => (onMicKey ? onMicKey.split(",") : []), [onMicKey]);
  useSubscriptions(session.identity, onMic);

  return (
    <>
      <WorldCanvas />
      <div className="hud">
        <Scoreboard me={session.identity} />
        <Feed />
        <VideoGrid me={session.identity} />
        <DemonChat session={session} />
        <RoomMicButton session={session} />
        <Talents session={session} />
        <MatchBanner />
      </div>
    </>
  );
}
