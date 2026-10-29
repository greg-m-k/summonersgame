import { existsSync } from "node:fs";
import { resolve } from "node:path";

for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(p)) {
    process.loadEnvFile(p);
    break;
  }
}

export const env = {
  SERVER_URL: process.env.GAME_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  WEB_URL: process.env.WEB_URL ?? "http://localhost:5173",
  GAME_SERVER_SECRET: process.env.GAME_SERVER_SECRET ?? "change-me",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
};
