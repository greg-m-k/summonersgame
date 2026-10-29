import {
  AccessToken,
  AgentDispatchClient,
  DataPacket_Kind,
  RoomServiceClient,
  TrackSource,
  type VideoGrant,
} from "livekit-server-sdk";
import { TOPIC_POSITIONS, TOPIC_WORLD, encode } from "@summoners/shared";
import { env, livekitHttpUrl } from "./env.ts";

export const roomService = new RoomServiceClient(livekitHttpUrl, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
export const agentDispatch = new AgentDispatchClient(livekitHttpUrl, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

export async function mintPlayerToken(room: string, identity: string, name: string): Promise<string> {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity, name, ttl: "6h" });
  const grant: VideoGrant = {
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  };
  at.addGrant(grant);
  return at.toJwt();
}

export async function broadcastReliable(room: string, payload: unknown): Promise<void> {
  try {
    await roomService.sendData(room, encode(payload), DataPacket_Kind.RELIABLE, { topic: TOPIC_WORLD });
  } catch (err) {
    // Room may not exist yet (nobody connected). Not fatal.
    if (!/not found|does not exist/i.test(String(err))) console.warn("[livekit] sendData failed:", err);
  }
}

/** Reliable broadcast on any topic (cost summaries and the like). */
export async function broadcast(room: string, topic: string, payload: unknown): Promise<void> {
  try {
    await roomService.sendData(room, encode(payload), DataPacket_Kind.RELIABLE, { topic });
  } catch (err) {
    if (!/not found|does not exist/i.test(String(err))) console.warn(`[livekit] sendData (${topic}) failed:`, err);
  }
}

export async function broadcastLossy(room: string, payload: unknown): Promise<void> {
  try {
    await roomService.sendData(room, encode(payload), DataPacket_Kind.LOSSY, { topic: TOPIC_POSITIONS });
  } catch {
    // dropped on purpose
  }
}

export async function sendToIdentity(room: string, identity: string, topic: string, payload: unknown): Promise<void> {
  try {
    await roomService.sendData(room, encode(payload), DataPacket_Kind.RELIABLE, {
      topic,
      destinationIdentities: [identity],
    });
  } catch (err) {
    console.warn(`[livekit] sendData to ${identity} failed:`, err);
  }
}

/** Track SID of a participant's microphone publication, if they have one right now. */
export async function micTrackSid(room: string, identity: string): Promise<string | null> {
  try {
    const info = await roomService.getParticipant(room, identity);
    const mic = info.tracks.find((t) => t.source === TrackSource.MICROPHONE);
    return mic?.sid ?? null;
  } catch {
    return null;
  }
}

/** Subscribe or unsubscribe one participant (the demon) from another's mic track. */
export async function setSubscribed(room: string, subscriber: string, trackSid: string, subscribe: boolean): Promise<void> {
  await roomService.updateSubscriptions(room, subscriber, [trackSid], subscribe);
}
