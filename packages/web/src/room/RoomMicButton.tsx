import { useLocalParticipant, useParticipants, useRoomContext } from "@livekit/components-react";
import type { ParticipantTrackPermission } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Session, setRoomMic } from "../api.ts";
import { useWorldStore } from "../world/useWorldStore.ts";

/**
 * Hold to talk to the other humans. While held the server routes your mic to them and away from
 * your demon, and your mic-time bank drains one second per second.
 */
export function RoomMicButton({ session }: { session: Session }) {
  const room = useRoomContext();
  const participants = useParticipants();
  const me = useWorldStore((s) => s.world.players[session.identity]);
  const bank = me?.micBank ?? 0;
  const serverOn = me?.onRoomMic ?? false;
  const demonIdentity = me?.demonIdentity ?? null;

  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevOn = useRef(serverOn);

  const humansKey = participants
    .filter((p) => !p.attributes?.demon_for && p.identity !== session.identity)
    .map((p) => p.identity)
    .sort()
    .join(",");

  // Publisher-side permission: my demon may take anything; other humans may always take my camera,
  // and my mic only while I hold the button. (Permissions are per participant, so the camera must be
  // listed explicitly or it would be blocked along with the mic.)
  const { cameraTrack, microphoneTrack } = useLocalParticipant();
  const camSid = cameraTrack?.trackSid;
  const micSid = microphoneTrack?.trackSid;
  useEffect(() => {
    if (!camSid) return;
    if (!demonIdentity) {
      // Demon unknown (still joining, or its pipeline died): fall back to allow-all. Other clients only
      // subscribe to a mic during mic_time anyway, so this is safe and keeps cameras flowing.
      if (import.meta.env.DEV) console.debug("[perm]", JSON.stringify({ camSid, micSid, holding, allowed: "all" }));
      room.localParticipant.setTrackSubscriptionPermissions(true);
      return;
    }
    const allowed: ParticipantTrackPermission[] = [{ participantIdentity: demonIdentity, allowAll: true }];
    if (humansKey) {
      const sids = holding && micSid ? [camSid, micSid] : [camSid];
      for (const id of humansKey.split(",")) allowed.push({ participantIdentity: id, allowedTrackSids: sids });
    }
    if (import.meta.env.DEV) console.debug("[perm]", JSON.stringify({ camSid, micSid, holding, allowed }));
    room.localParticipant.setTrackSubscriptionPermissions(false, allowed);
  }, [room, demonIdentity, holding, humansKey, camSid, micSid]);

  // Server cut us off (bank empty): release.
  useEffect(() => {
    if (prevOn.current && !serverOn && holding) setHolding(false);
    prevOn.current = serverOn;
  }, [serverOn, holding]);

  const press = useCallback(async () => {
    if (holding || bank <= 0) return;
    setHolding(true);
    setError(null);
    const r = await setRoomMic(session, true);
    if (!r.ok) {
      setHolding(false);
      setError(r.reason ?? "refused");
    }
  }, [holding, bank, session]);

  const release = useCallback(async () => {
    if (!holding) return;
    setHolding(false);
    await setRoomMic(session, false);
  }, [holding, session]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        void press();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") void release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [press, release]);

  const empty = bank <= 0 && !holding;
  return (
    <div className="mic-dock">
      <button
        type="button"
        className={`mic-button${holding ? " holding" : ""}`}
        disabled={empty}
        onPointerDown={(e) => {
          e.preventDefault();
          void press();
        }}
        onPointerUp={() => void release()}
        onPointerLeave={() => void release()}
        onPointerCancel={() => void release()}
      >
        {holding ? "HUMANS HEAR YOU" : empty ? "EARN POINTS FOR MIC TIME" : "HOLD: TALK TO HUMANS"}
        <span className="mic-bank">{Math.ceil(bank)}s</span>
      </button>
      <div className="mic-hint">{error ?? (me ? `Your demon: ${me.persona}. Hold the button or Space.` : "Connecting...")}</div>
    </div>
  );
}
