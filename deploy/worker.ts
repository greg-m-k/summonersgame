import { Container, getContainer } from "@cloudflare/containers";

/**
 * The edge of Summoners on Cloudflare. One Worker serves the built client as static assets under
 * /summoners, proxies /summoners/api/* to the game server container, and wakes the demons
 * container whenever someone joins. Both containers sleep when nobody has played for a while.
 */

interface Env {
  ASSETS: Fetcher;
  GAME_SERVER: DurableObjectNamespace<GameServer>;
  DEMON_WORKER: DurableObjectNamespace<DemonWorker>;
  PUBLIC_URL: string;
  HEART_HP?: string;
  ROOM_BUDGET_USD?: string;
  // secrets
  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  CARTESIA_API_KEY?: string;
  FAL_API_KEY?: string;
  GAME_SERVER_SECRET: string;
}

const BASE = "/summoners";
const SERVER_PORT = 8787;
const AGENTS_PORT = 8081;

function sharedEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {
    LIVEKIT_URL: env.LIVEKIT_URL ?? "",
    LIVEKIT_API_KEY: env.LIVEKIT_API_KEY ?? "",
    LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET ?? "",
    GAME_SERVER_SECRET: env.GAME_SERVER_SECRET ?? "",
    GAME_SERVER_URL: env.PUBLIC_URL,
    NODE_ENV: "production",
  };
  for (const k of ["ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "FAL_API_KEY", "HEART_HP", "ROOM_BUDGET_USD"] as const) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

type Ctx = ConstructorParameters<typeof Container>[0];

export class GameServer extends Container<Env> {
  defaultPort = SERVER_PORT;
  sleepAfter = "20m";

  constructor(ctx: Ctx, env: Env) {
    super(ctx, env);
    this.envVars = { ...sharedEnv(env), PORT: String(SERVER_PORT) };
  }
}

export class DemonWorker extends Container<Env> {
  defaultPort = AGENTS_PORT;
  sleepAfter = "20m";

  constructor(ctx: Ctx, env: Env) {
    super(ctx, env);
    this.envVars = { ...sharedEnv(env), AGENT_PORT: String(AGENTS_PORT) };
  }
}

/** Nudge the demons container so it is running (and stays running) while people play. */
async function wakeDemons(env: Env): Promise<void> {
  try {
    const demons = getContainer(env.DEMON_WORKER, "main");
    await demons.fetch(new Request("http://demons/", { method: "GET" }));
  } catch (err) {
    console.warn("demons container not ready", err instanceof Error ? err.message : err);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === BASE) return Response.redirect(`${url.origin}${BASE}/`, 302);
    if (!url.pathname.startsWith(`${BASE}/`)) return new Response("not here", { status: 404 });

    if (url.pathname.startsWith(`${BASE}/api/`)) {
      if (url.pathname === `${BASE}/api/join`) ctx.waitUntil(wakeDemons(env));
      const server = getContainer(env.GAME_SERVER, "main");
      const inner = new URL(request.url);
      inner.pathname = url.pathname.slice(BASE.length);
      return server.fetch(new Request(inner, request));
    }

    // Static client, with the SPA's index for any route that is not a file.
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    if (request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html")) {
      return env.ASSETS.fetch(new Request(`${url.origin}${BASE}/index.html`, request));
    }
    return asset;
  },

  /** Every five minutes: while rooms are live keep the demons awake; otherwise let both sleep. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const server = getContainer(env.GAME_SERVER, "main");
        const res = await server.fetch(new Request("http://server/api/health")).catch(() => null);
        if (!res?.ok) return;
        const health = (await res.json()) as { rooms?: string[] };
        if (health.rooms?.length) await wakeDemons(env);
      })(),
    );
  },
};
