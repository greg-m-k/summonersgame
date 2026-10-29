import { MATCH_OVER_MS, TEAM_INFO } from "@summoners/shared";
import { useEffect, useState } from "react";
import { useWorldStore } from "../world/useWorldStore.ts";

/** The result screen: who won, the scores, and every bribe each player took this match. */
export function MatchBanner() {
  const match = useWorldStore((s) => s.world.match);
  const players = useWorldStore((s) => s.world.players);
  const over = useWorldStore((s) => s.lastMatchOver);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (match.phase !== "over") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [match.phase]);

  if (match.phase !== "over") return null;
  const info = match.winner ? TEAM_INFO[match.winner] : null;
  const left = Math.max(0, Math.ceil(((match.endedAt ?? now) + MATCH_OVER_MS - now) / 1000));
  const ranked = Object.values(players).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const bribes = over?.match.number === match.number ? over.bribes : {};

  return (
    <div className="match-banner" style={{ borderColor: info?.color ?? "var(--line)" }}>
      <div className="match-title" style={{ color: info?.color ?? "var(--text)" }}>
        {info ? `TEAM ${info.name.toUpperCase()} WINS` : "NOBODY WINS"}
      </div>
      <div className="match-sub">
        match {match.number} · next dream in {left}s
      </div>
      <div className="match-players">
        {ranked.map((p) => {
          const taken = bribes[p.identity] ?? [];
          return (
            <div key={p.identity} className="match-player">
              <div className="match-player-head">
                <span style={{ color: TEAM_INFO[p.team].color }}>{p.name}</span>
                <span className="match-score">{p.score}</span>
              </div>
              <div className={`match-bribes${taken.length ? " dirty" : ""}`}>
                {taken.length ? taken.map((b, i) => <div key={i}>took a bribe: {b}</div>) : "stayed clean"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
