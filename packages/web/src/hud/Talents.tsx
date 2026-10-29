import { BRANCH_INFO, Branch, TALENTS, talentBlocker, xpAtLevel, xpToNext } from "@summoners/shared";
import { type CSSProperties, useEffect, useState } from "react";
import { type Session, chooseTalent } from "../api.ts";
import { useWorldStore } from "../world/useWorldStore.ts";

/** Level, XP bar, and the talent tree. Opens with the button or the T key. */
export function Talents({ session }: { session: Session }) {
  const me = useWorldStore((s) => s.world.players[session.identity]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyT" && !(e.target instanceof HTMLInputElement)) setOpen((o) => !o);
      if (e.code === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!me) return null;
  const into = me.xp - xpAtLevel(me.level);
  const need = xpToNext(me.level);
  const points = me.talentPoints;

  const take = async (id: string) => {
    setError(null);
    const r = await chooseTalent(session, id);
    if (!r.ok) setError(r.reason ?? "refused");
  };

  return (
    <>
      <button type="button" className={`talents-toggle${points > 0 ? " has-points" : ""}`} onClick={() => setOpen((o) => !o)} title="talents (T)">
        <span className="talents-level">L{me.level}</span>
        <span className="talents-xp">
          <i style={{ width: `${Math.min(100, (into / need) * 100)}%` }} />
        </span>
        <span className="talents-points">{points > 0 ? `${points} talent point${points === 1 ? "" : "s"}` : "talents"}</span>
      </button>
      {open && (
        <div className="talents-panel">
          <div className="talents-head">
            <span>
              Level {me.level} · {into}/{need} XP · {points} point{points === 1 ? "" : "s"} to spend
            </span>
            <button type="button" className="talents-close" onClick={() => setOpen(false)}>
              close
            </button>
          </div>
          <div className="talents-branches">
            {Branch.options.map((branch) => {
              const info = BRANCH_INFO[branch];
              return (
                <div key={branch} className="talents-branch" style={{ "--branch": info.color } as CSSProperties}>
                  <div className="talents-branch-name">{info.name}</div>
                  <div className="talents-branch-blurb">{info.blurb}</div>
                  {TALENTS.filter((t) => t.branch === branch).map((t) => {
                    const owned = me.talents.includes(t.id);
                    const why = owned ? null : talentBlocker(t.id, me.talents, points);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`talent${owned ? " owned" : ""}${!owned && !why ? " available" : ""}`}
                        disabled={owned || why !== null}
                        onClick={() => void take(t.id)}
                        title={why ?? (owned ? "taken" : "take this talent")}
                        data-talent={t.id}
                      >
                        <span className="talent-tier">{t.tier}</span>
                        <span className="talent-name">{t.name}</span>
                        <span className="talent-text">{t.text}</span>
                        {why && !owned && <span className="talent-why">{why}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {error && <div className="talents-error">{error}</div>}
          <div className="talents-hint">Points pay XP. Each level: one talent point and 20 s of mic time. Every kill makes that creature 10% stronger.</div>
        </div>
      )}
    </>
  );
}
