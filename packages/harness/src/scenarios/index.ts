import type { Scenario } from "../scenario.ts";
import { browser } from "./browser.ts";
import { duel } from "./duel.ts";
import { explore } from "./explore.ts";
import { micTime } from "./micTime.ts";
import { smoke } from "./smoke.ts";
import { versus } from "./versus.ts";
import { voice } from "./voice.ts";

export const SCENARIOS: Record<string, Scenario> = {
  smoke,
  duel,
  "mic-time": micTime,
  voice,
  versus,
  explore,
  browser,
};
