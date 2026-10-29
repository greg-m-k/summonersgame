import type { JoinResponse } from "@summoners/shared";

export interface Session extends JoinResponse {
  room: string;
  name: string;
}

const KEY = "summoners.session";

/** The API lives next to the client: /api in dev, /summoners/api behind the Worker in production. */
export const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

/** Server-relative URLs (pictures come back as /api/img/...) rebased under the deployment prefix. */
export const withBase = (url: string): string => (url.startsWith("/api/") ? `${API_BASE}${url.slice(4)}` : url);

export async function join(room: string, name: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room, name }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? "join failed");
  const data = (await res.json()) as JoinResponse;
  const session: Session = { ...data, room, name };
  sessionStorage.setItem(KEY, JSON.stringify(session));
  return session;
}

export function loadSession(room: string): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s.room === room ? s : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY);
}

export async function chooseTalent(session: Session, talentId: string): Promise<{ ok: boolean; reason?: string }> {
  const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(session.room)}/talent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: session.identity, sessionKey: session.sessionKey, talentId }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, reason: body.error ?? res.statusText };
}

export async function setRoomMic(session: Session, on: boolean): Promise<{ ok: boolean; reason?: string }> {
  const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(session.room)}/mic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: session.identity, sessionKey: session.sessionKey, on }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, reason: body.error ?? res.statusText };
}
