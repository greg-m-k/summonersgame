import { z } from "zod";
import { WorldEvent } from "./events.ts";

/** LiveKit data-channel topics. */
export const TOPIC_WORLD = "world";
export const TOPIC_POSITIONS = "positions";
export const TOPIC_DEMON = "demon";
/** LiveKit text-stream topic the agents framework listens on for typed input to a demon. */
export const TOPIC_CHAT = "lk.chat";

/**
 * Transcript prefix emitted by the mock speech-to-text when no STT provider is configured. Demons
 * answer it in character but never forward it to the game master.
 */
export const UNINTELLIGIBLE_PREFIX = "(unintelligible";

/** Server -> one demon agent (sent with destinationIdentities). */
export const DemonMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("demon_pause"), on: z.boolean() }),
  z.object({ type: z.literal("world_event"), event: WorldEvent }),
  /** A bribe to whisper to the player: do this, earn that many mic seconds, nobody else hears. */
  z.object({ type: z.literal("temptation"), id: z.string(), text: z.string(), rewardSeconds: z.number(), expiresAt: z.number() }),
  z.object({ type: z.literal("temptation_result"), id: z.string(), text: z.string(), success: z.boolean(), rewardSeconds: z.number() }),
]);
export type DemonMessage = z.infer<typeof DemonMessage>;

/** Server -> one player's client (sent with destinationIdentities): things only they may know. */
export const TOPIC_SECRET = "secret";
export const SecretMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("temptation"), id: z.string(), text: z.string(), rewardSeconds: z.number(), expiresAt: z.number() }),
  z.object({ type: z.literal("temptation_result"), id: z.string(), text: z.string(), success: z.boolean(), rewardSeconds: z.number() }),
]);
export type SecretMessage = z.infer<typeof SecretMessage>;

/** Agent -> game server, HTTP. */
export const TranscriptPost = z.object({
  playerIdentity: z.string(),
  text: z.string().min(1).max(2000),
  ts: z.number(),
});
export type TranscriptPost = z.infer<typeof TranscriptPost>;

export const DemonRegisterPost = z.object({
  playerIdentity: z.string(),
  demonIdentity: z.string(),
  status: z.enum(["online", "error"]).default("online"),
  detail: z.string().max(300).optional(),
  /** Pipeline stages running on mocks because their API key is missing: "stt", "llm", "tts". */
  mocks: z.array(z.enum(["stt", "llm", "tts"])).optional(),
});
export type DemonRegisterPost = z.infer<typeof DemonRegisterPost>;

/** Client -> game server, HTTP. */
export const JoinRequest = z.object({
  room: z.string().regex(/^[a-z0-9-]{3,24}$/, "lowercase letters, digits, dashes"),
  name: z.string().trim().min(1).max(24),
});
export type JoinRequest = z.infer<typeof JoinRequest>;

export const JoinResponse = z.object({
  url: z.string(),
  token: z.string(),
  identity: z.string(),
  persona: z.string(),
  sessionKey: z.string(),
});
export type JoinResponse = z.infer<typeof JoinResponse>;

export const TalentRequest = z.object({
  identity: z.string(),
  sessionKey: z.string(),
  talentId: z.string(),
});
export type TalentRequest = z.infer<typeof TalentRequest>;

export const RoomMicRequest = z.object({
  identity: z.string(),
  sessionKey: z.string(),
  on: z.boolean(),
});
export type RoomMicRequest = z.infer<typeof RoomMicRequest>;

export const encode = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));
export const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
