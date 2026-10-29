import type { CSSProperties } from "react";
import { TEAM_IDS, TEAM_INFO, heartId } from "@summoners/shared";
import { useCostStore, usd } from "../room/useCostStore.ts";
import { useWorldStore } from "../world/useWorldStore.ts";

export function Scoreboard({ me }: { me: string }) {
  const players = useWorldStore((s) => s.world.players);
  const entities = useWorldStore((s) => s.world.entities);
  const match = useWorldStore((s) => s.world.match);
  const cost = useCostStore((s) => s.summary);
  const creatures = Object.values(entities).filter((e) => !e.heart).length;

  return (
    <div className={`scoreboard${cost?.overBudget ? " over-budget" : ""}`}>
      <div className="scoreboard-title">
        SUMMONERS{" "}
        <span className="dim">
          match {match.number} · {creatures} things
        </span>
        {cost && (
          <span className="score-cost" title="estimated spend in this room at list prices, and the pace over the last five minutes">
            {usd(cost.totalUsd)} · {usd(cost.paceUsdPerHour)}/h
          </span>
        )}
      </div>
      {cost?.overBudget && <div className="score-budget">BUDGET REACHED ({usd(cost.budgetUsd ?? 0)}): demons silenced</div>}
      {TEAM_IDS.map((team) => {
        const info = TEAM_INFO[team];
        const heart = entities[heartId(team)];
        const members = Object.values(players)
          .filter((p) => p.team === team)
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        const hp = heart ? heart.hp / Math.max(1, heart.maxHp) : 0;
        return (
          <div key={team} className="team" style={{ "--team": info.color } as CSSProperties}>
            <div className="team-head">
              <span className="team-name">{info.name}</span>
              <span className="team-heart" title="heart hit points">
                <i style={{ width: `${hp * 100}%` }} />
              </span>
              <span className="team-hp">{heart ? heart.hp : "fallen"}</span>
            </div>
            {members.length === 0 && <div className="score-row empty">nobody yet</div>}
            {members.map((p) => (
              <div key={p.identity} className={`score-row${p.identity === me ? " me" : ""}${p.onRoomMic ? " on-mic" : ""}`}>
                <span className="score-name">
                  {p.name} <small className="score-level">L{p.level}</small>
                </span>
                <span className="score-persona">{p.persona}</span>
                <span className="score-pts">{p.score}</span>
                <span className="score-bank">{Math.round(p.micBank)}s</span>
                <span className="score-usd" title="this player's share of the spend">
                  {cost ? usd(cost.byPlayer[p.identity]?.usd) : ""}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
