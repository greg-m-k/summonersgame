import { useParticipants, useTracks } from "@livekit/components-react";
import { RemoteTrackPublication, Track } from "livekit-client";
import { useEffect, useRef, useState } from "react";

/**
 * Selective subscription: everyone's camera, only my own demon's voice, and another human's mic
 * only while that human is on the room mic. The room is joined with autoSubscribe: false.
 */
export function useSubscriptions(me: string, onMic: string[]): void {
  const tracks = useTracks([Track.Source.Camera, Track.Source.Microphone, Track.Source.Unknown], {
    onlySubscribed: false,
  });
  const participants = useParticipants();
  const [tick, setTick] = useState(0);
  // Subscriptions requested before the publisher granted permission can sit in "desired" forever;
  // remember when we first asked so we can re-issue the request.
  const pending = useRef(new Map<string, number>());

  // Attributes (demon_for) and permissions can arrive after the track does; re-evaluate on a heartbeat.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onMicSet = new Set(onMic);
    const now = Date.now();
    for (const t of tracks) {
      const pub = t.publication;
      if (!(pub instanceof RemoteTrackPublication)) continue;
      const p = t.participant;
      const demonFor = p.attributes?.demon_for;
      let want: boolean;
      if (pub.kind === Track.Kind.Video) want = !demonFor;
      else if (demonFor) want = demonFor === me;
      else want = onMicSet.has(p.identity);

      if (!want) {
        pending.current.delete(pub.trackSid);
        if (pub.isSubscribed || pub.isDesired) pub.setSubscribed(false);
        continue;
      }
      if (pub.isSubscribed) {
        pending.current.delete(pub.trackSid);
        continue;
      }
      const since = pending.current.get(pub.trackSid);
      if (since === undefined) {
        pending.current.set(pub.trackSid, now);
        pub.setSubscribed(true);
      } else if (now - since > 2500) {
        // Stuck in "desired": toggle so the server re-evaluates with current permissions.
        pending.current.set(pub.trackSid, now);
        pub.setSubscribed(false);
        setTimeout(() => pub.setSubscribed(true), 150);
      }
    }
  }, [tracks, participants, onMic, me, tick]);
}
