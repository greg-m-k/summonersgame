import { useEffect, useRef } from "react";
import { useWorldStore } from "../world/useWorldStore.ts";

export function Feed() {
  const feed = useWorldStore((s) => s.feed);
  const mood = useWorldStore((s) => s.world.environment.mood);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [feed]);

  return (
    <div className="feed">
      <div className="feed-mood">{mood}</div>
      <div className="feed-lines" ref={ref}>
        {feed.slice(-18).map((l) => (
          <div key={l.id} className={`feed-line kind-${l.kind}`}>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
