import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { join } from "../api.ts";

function randomCode(): string {
  const words = ["ember", "velvet", "static", "moth", "saline", "halo", "rust", "orchid", "zenith", "gloam"];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.floor(Math.random() * 900 + 100)}`;
}

export function Lobby() {
  const navigate = useNavigate();
  const [name, setName] = useState(() => localStorage.getItem("summoners.name") ?? "");
  const [room, setRoom] = useState(() => new URLSearchParams(location.search).get("room") ?? randomCode());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const code = room.trim().toLowerCase();
      localStorage.setItem("summoners.name", name.trim());
      await join(code, name.trim());
      navigate(`/room/${encodeURIComponent(code)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <main className="lobby">
      <h1>SUMMONERS</h1>
      <p className="tagline">Everyone talks to their demon at once. The dream listens. Things happen.</p>
      <form onSubmit={submit}>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required autoFocus placeholder="Greg" />
        </label>
        <label>
          Room code
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            pattern="[a-z0-9\-]{3,24}"
            title="lowercase letters, digits, dashes"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Opening the dream..." : "Enter the dream"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
      <p className="hint">Share the room code. Camera and microphone are required; headphones strongly recommended.</p>
    </main>
  );
}
