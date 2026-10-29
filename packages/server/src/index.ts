import cors from "@fastify/cors";
import Fastify from "fastify";
import { env } from "./env.ts";
import { RoomRegistry } from "./rooms.ts";
import { registerRoutes } from "./routes.ts";

const app = Fastify({ logger: { level: "warn" } });
await app.register(cors, { origin: true });

const rooms = new RoomRegistry();
registerRoutes(app, rooms);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
console.log(`[server] listening on http://localhost:${env.PORT}  livekit=${env.LIVEKIT_URL}`);
console.log(
  `[server] game master=${process.env.GM_MOCK === "1" || !env.ANTHROPIC_API_KEY ? "mock" : "claude"} images=${env.FAL_KEY ? "fal" : "mock (no FAL_KEY)"}`,
);
