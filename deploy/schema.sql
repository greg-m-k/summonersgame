-- Session log: one row per thing that happened in a room. Written by the Worker's /_ops/log route
-- from batches the game server posts; read by scripts/session-report.mjs.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_room_ts ON events (room, ts);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
