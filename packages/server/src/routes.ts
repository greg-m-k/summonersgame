import type { FastifyInstance } from "fastify";
import { type CostSummary, DemonRegisterPost, JoinRequest, RoomMicRequest, TalentRequest, TranscriptPost, UsagePost } from "@summoners/shared";
import { env } from "./env.ts";
import type { RoomRegistry } from "./rooms.ts";

export function registerRoutes(app: FastifyInstance, rooms: RoomRegistry): void {
  // Every stage runs on a mock when its key is missing, so the game is playable with no keys at all.
  app.get("/api/health", async () => ({
    ok: true,
    rooms: rooms.list(),
    gm: process.env.GM_MOCK === "1" || !env.ANTHROPIC_API_KEY ? "mock" : "claude",
    images: env.FAL_KEY ? "fal" : "mock",
    demon: {
      stt: process.env.DEEPGRAM_API_KEY ? "deepgram" : "mock",
      llm: env.ANTHROPIC_API_KEY ? "claude" : "mock",
      tts: process.env.CARTESIA_API_KEY ? "cartesia" : "mock",
    },
  }));

  app.post("/api/join", async (req, reply) => {
    const parsed = JoinRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad request" });
    const room = rooms.getOrCreate(parsed.data.room);
    const r = await room.join(parsed.data.name);
    return { url: env.LIVEKIT_URL, ...r };
  });

  app.get<{ Params: { room: string } }>("/api/rooms/:room/state", async (req, reply) => {
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    return room.world.snapshot();
  });

  app.post<{ Params: { room: string } }>("/api/rooms/:room/mic", async (req, reply) => {
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    const parsed = RoomMicRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad request" });
    if (!room.verify(parsed.data.identity, parsed.data.sessionKey)) return reply.code(403).send({ error: "bad session" });
    const result = await room.mic.request(parsed.data.identity, parsed.data.on);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return { ok: true, player: room.world.player(parsed.data.identity) };
  });

  app.post<{ Params: { room: string } }>("/api/rooms/:room/talent", async (req, reply) => {
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    const parsed = TalentRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad request" });
    if (!room.verify(parsed.data.identity, parsed.data.sessionKey)) return reply.code(403).send({ error: "bad session" });
    const why = room.world.chooseTalent(parsed.data.identity, parsed.data.talentId);
    if (why) return reply.code(409).send({ error: why });
    return { ok: true, player: room.world.player(parsed.data.identity) };
  });

  // Agent-only routes, protected by the shared secret.
  const agentOnly = (headers: Record<string, unknown>): boolean => headers["x-game-secret"] === env.GAME_SERVER_SECRET;

  app.get<{ Params: { room: string } }>("/api/rooms/:room/debug", async (req, reply) => {
    if (!agentOnly(req.headers)) return reply.code(403).send({ error: "forbidden" });
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    return room.debug();
  });

  // Per-stage latency from the demon pipeline (Deepgram end-of-turn, Claude first token, Cartesia first audio).
  app.post<{ Params: { room: string }; Body: { playerIdentity?: string } }>("/api/rooms/:room/metric", async (req, reply) => {
    if (!agentOnly(req.headers)) return reply.code(403).send({ error: "forbidden" });
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    room.log.add("metric", req.body);
    return { ok: true };
  });

  app.post<{ Params: { room: string } }>("/api/rooms/:room/demon-said", async (req, reply) => {
    if (!agentOnly(req.headers)) return reply.code(403).send({ error: "forbidden" });
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    const parsed = TranscriptPost.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad request" });
    return room.demonSaid(parsed.data.playerIdentity, parsed.data.text) ? { ok: true } : reply.code(404).send({ error: "unknown player" });
  });

  app.post<{ Params: { room: string } }>("/api/rooms/:room/transcript", async (req, reply) => {
    if (!agentOnly(req.headers)) return reply.code(403).send({ error: "forbidden" });
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    const parsed = TranscriptPost.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad request" });
    const ok = room.transcript(parsed.data.playerIdentity, parsed.data.text, parsed.data.ts);
    return ok ? { ok: true } : reply.code(404).send({ error: "unknown player" });
  });

  app.post<{ Params: { room: string } }>("/api/rooms/:room/demon", async (req, reply) => {
    if (!agentOnly(req.headers)) return reply.code(403).send({ error: "forbidden" });
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    const parsed = DemonRegisterPost.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad request" });
    const ok = room.registerDemon(
      parsed.data.playerIdentity,
      parsed.data.demonIdentity,
      parsed.data.status,
      parsed.data.detail,
      parsed.data.mocks,
    );
    return ok ? { ok: true } : reply.code(404).send({ error: "unknown player" });
  });

  app.post<{ Params: { room: string } }>("/api/rooms/:room/usage", async (req, reply) => {
    if (!agentOnly(req.headers)) return reply.code(403).send({ error: "forbidden" });
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    const parsed = UsagePost.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad request" });
    const ok = room.usage(parsed.data.playerIdentity, parsed.data.events);
    return ok ? { ok: true } : reply.code(404).send({ error: "unknown player" });
  });

  // Cost: estimated spend at list prices, by service and by player, with a $/hour pace.
  app.get<{ Params: { room: string } }>("/api/rooms/:room/cost", async (req, reply) => {
    const room = rooms.get(req.params.room);
    if (!room) return reply.code(404).send({ error: "no such room" });
    return room.cost.summary();
  });

  app.get("/api/cost", async () => {
    const byRoom: Record<string, CostSummary> = {};
    let totalUsd = 0;
    for (const name of rooms.list()) {
      const s = rooms.get(name)!.cost.summary();
      byRoom[name] = s;
      totalUsd += s.totalUsd;
    }
    return { totalUsd, rooms: byRoom };
  });

  app.get<{ Params: { id: string } }>("/api/img/:id", async (req, reply) => {
    for (const name of rooms.list()) {
      const img = rooms.get(name)?.images.get(req.params.id);
      if (img) {
        return reply
          .header("content-type", img.contentType)
          .header("cache-control", "public, max-age=86400, immutable")
          .send(img.bytes);
      }
    }
    return reply.code(404).send({ error: "no such image" });
  });
}
