import { VideoTrack, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useWorldStore } from "../world/useWorldStore.ts";
import { useCostStore, usd } from "./useCostStore.ts";

export function VideoGrid({ me }: { me: string }) {
  const cams = useTracks([Track.Source.Camera], { onlySubscribed: false }).filter(
    (t) => !t.participant.attributes?.demon_for,
  );
  const players = useWorldStore((s) => s.world.players);
  const cost = useCostStore((s) => s.summary);

  return (
    <div className="video-grid">
      {cams.map((t) => {
        const id = t.participant.identity;
        const p = players[id];
        const isMe = id === me;
        return (
          <div key={t.publication?.trackSid ?? id} className={`tile${isMe ? " me" : ""}${p?.onRoomMic ? " on-mic" : ""}`}>
            <VideoTrack trackRef={t} />
            <div className="tile-overlay">
              <span className="tile-name">{p?.name ?? t.participant.name ?? id}</span>
              {p && (
                <span className="tile-meta">
                  L{p.level} · {p.persona} · {p.score} pts · {Math.round(p.micBank)}s{cost ? ` · ${usd(cost.byPlayer[id]?.usd)}` : ""}
                </span>
              )}
              {p?.onRoomMic && <span className="tile-badge">ON ROOM MIC</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
