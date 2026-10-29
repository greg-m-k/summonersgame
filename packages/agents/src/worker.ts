import { fileURLToPath } from "node:url";
import { ServerOptions, cli } from "@livekit/agents";
import { loadEnv } from "./env.ts";

loadEnv();

// agentName enables explicit dispatch: the game server creates one dispatch per player,
// so this worker only joins rooms when asked and never auto-joins.
// The default load function marks the worker unavailable when host CPU is busy, which on a dev
// machine silently drops every dispatch ("no servers available" in the LiveKit log). Ignore host
// load unless asked to respect it. LiveKit Cloud deployments override this anyway.
const respectLoad = process.env.DEMON_RESPECT_LOAD === "1";

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(new URL("./demon.ts", import.meta.url)),
    agentName: process.env.DEMON_AGENT_NAME ?? "demon",
    ...(respectLoad ? {} : { loadFunc: async () => 0 }),
    // Keep one warm job process so the first demon joins fast, and give slow machines time to
    // initialize the inference runners (the default timeout failed on a loaded dev box).
    numIdleProcesses: 1,
    initializeProcessTimeout: 60_000,
    // In a container the health server must sit on a known port on every interface.
    ...(process.env.AGENT_PORT ? { host: "0.0.0.0", port: Number(process.env.AGENT_PORT) } : {}),
  }),
);
