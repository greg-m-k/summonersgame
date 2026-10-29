import { useDataChannel, useRoomInfo } from "@livekit/components-react";
import {
  CostSummary,
  PositionsPacket,
  SecretMessage,
  TOPIC_COST,
  TOPIC_POSITIONS,
  TOPIC_SECRET,
  TOPIC_WORLD,
  WorldEvent,
  WorldState,
  decode,
} from "@summoners/shared";
import { useEffect } from "react";
import { useWorldStore } from "../world/useWorldStore.ts";
import { useCostStore } from "./useCostStore.ts";
import { SECRET, useChatStore } from "./useTranscripts.ts";

/** Mirrors the server's world into the store: reliable events, lossy positions, and the metadata snapshot. */
export function useWorldSync(): void {
  const apply = useWorldStore((s) => s.apply);
  const setPositions = useWorldStore((s) => s.setPositions);
  const setSnapshot = useWorldStore((s) => s.setSnapshot);
  const pruneGhosts = useWorldStore((s) => s.pruneGhosts);
  const { metadata } = useRoomInfo();

  useDataChannel(TOPIC_WORLD, (msg) => {
    const parsed = WorldEvent.safeParse(decode(msg.payload));
    if (parsed.success) {
      if (import.meta.env.DEV) console.debug("[world]", parsed.data.type);
      apply(parsed.data);
    } else console.warn("bad world event", parsed.error.issues[0]);
  });

  useEffect(() => {
    (window as unknown as { __world: typeof useWorldStore }).__world = useWorldStore; // for the harness, in every build
  }, []);

  useDataChannel(TOPIC_POSITIONS, (msg) => {
    const parsed = PositionsPacket.safeParse(decode(msg.payload));
    if (parsed.success) setPositions(parsed.data);
  });

  const setCost = useCostStore((s) => s.set);
  useDataChannel(TOPIC_COST, (msg) => {
    const parsed = CostSummary.safeParse(decode(msg.payload));
    if (parsed.success) setCost(parsed.data);
  });

  // Things only this player may know: the demon's private deals and how they ended.
  const upsertChat = useChatStore((s) => s.upsert);
  useDataChannel(TOPIC_SECRET, (msg) => {
    const parsed = SecretMessage.safeParse(decode(msg.payload));
    if (!parsed.success) return;
    const m = parsed.data;
    const secs = Math.max(0, Math.round((m.type === "temptation" ? m.expiresAt - Date.now() : 0) / 1000));
    const text =
      m.type === "temptation"
        ? `A deal: ${m.text} Pays ${m.rewardSeconds}s on the human mic. ${secs}s to do it.`
        : m.success
          ? `Deal done. +${m.rewardSeconds}s mic time. Nobody saw.`
          : `Deal lost: ${m.text}`;
    upsertChat({ id: `secret-${m.id}-${m.type}`, identity: SECRET, text, final: true, at: Date.now() });
  });
  useEffect(() => {
    (window as unknown as { __cost: typeof useCostStore }).__cost = useCostStore;
  }, []);

  useEffect(() => {
    if (!metadata) return;
    try {
      const parsed = WorldState.safeParse(JSON.parse(metadata));
      if (parsed.success) setSnapshot(parsed.data);
      else console.warn("room snapshot failed to parse", parsed.error.issues[0]);
    } catch {
      // not ours
    }
  }, [metadata, setSnapshot]);

  useEffect(() => {
    const t = setInterval(() => pruneGhosts(Date.now() - 1500), 500);
    return () => clearInterval(t);
  }, [pruneGhosts]);
}
