import { existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

/** Load the repo-root .env (or a local one) once. Node's loader never overrides variables already set. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
    if (existsSync(p)) {
      process.loadEnvFile(p);
      return;
    }
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}
