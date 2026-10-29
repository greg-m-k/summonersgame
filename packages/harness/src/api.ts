import { type CostSummary, JoinResponse, type WorldState } from "@summoners/shared";
import { env } from "./env.ts";

export interface Session extends JoinResponse {
  room: string;
  name: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${env.SERVER_URL}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

export const api = {
  health: () =>
    call<{
      ok: boolean;
      rooms: string[];
      gm: "mock" | "claude";
      images: "fal" | "mock";
      demon: { stt: string; llm: string; tts: string };
    }>("/api/health"),

  async join(room: string, name: string): Promise<Session> {
    const data = await call<JoinResponse>("/api/join", json({ room, name }));
    return { ...JoinResponse.parse(data), room, name };
  },

  state: (room: string) => call<WorldState>(`/api/rooms/${encodeURIComponent(room)}/state`),

  cost: (room: string) => call<CostSummary>(`/api/rooms/${encodeURIComponent(room)}/cost`),

  /** Inject a final transcript exactly as a demon would, bypassing audio. */
  transcript: (room: string, playerIdentity: string, text: string) =>
    call<{ ok: true }>(
      `/api/rooms/${encodeURIComponent(room)}/transcript`,
      json({ playerIdentity, text, ts: Date.now() }, { "x-game-secret": env.GAME_SERVER_SECRET }),
    ),

  async talent(session: Session, talentId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      await call(`/api/rooms/${encodeURIComponent(session.room)}/talent`, json({ identity: session.identity, sessionKey: session.sessionKey, talentId }));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  async mic(session: Session, on: boolean): Promise<{ ok: boolean; reason?: string }> {
    try {
      await call(`/api/rooms/${encodeURIComponent(session.room)}/mic`, json({ identity: session.identity, sessionKey: session.sessionKey, on }));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
};
