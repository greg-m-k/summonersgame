// AI art director for the game's looks. Renders a lab page with Playwright, shows the frames to
// Claude with a rubric, applies the parameter patch it proposes to the subject's look file, and
// repeats, keeping the best-scoring round.
//   node scripts/judge-look.mjs <hearts|arena> [rounds=4] [--web http://localhost:5173]
// Reads ANTHROPIC_API_KEY from the environment or the repo's .env. A few cents per round.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (!process.env.ANTHROPIC_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

const SUBJECTS = {
  hearts: {
    lookPath: "packages/web/src/world/heart3d/heartLook.json",
    views: ["/lab/hearts?still=1"],
    rubric: `You are the art director for a video game. The image shows two team hearts in the arena of a
voice-driven dream-fight game: Ash (left, fire and iron) and Tide (right, ice and deep water). They are
rendered live in WebGL from a parameter file. Goal: "super real" video-game hearts with artistic flair.
Think anatomical mass and weight, wet or crystalline surfaces, light that comes from inside, veins that
read as alive, vessels on top, a silhouette that is unmistakably a heart from 10 metres away, team colour
readable at a glance, nothing that looks like a toy valentine, a blob, or a flat sticker.

Score 0-10 on: silhouette, materials (realism), lighting/glow, team identity, flair, overall.
Then propose parameter changes as a JSON object in the "patch" string (deep-merged into the file). Keep
every change justified by what you see. Change at most 8 leaves per round. Allowed keys and ranges:
resolution 32-64 (mesh detail), scale 0.6-1.4, shape.{lobe 0.5-1.2 (lower = wider lobes), thickness 0.5-1.1},
pulse.{base 1-4, weakBoost 0-5, amount 0.02-0.2, sharpness 2-12}, float.{amplitude 0-0.3, speed 0.2-2}, rotateSpeed 0-1,
ash/tide.{color hex, emissive hex, emissiveIntensity 0-4, roughness 0-1, metalness 0-1, clearcoat 0-1,
clearcoatRoughness 0-1, bumpScale 0-0.08, veins.{color hex, density 0-1.5, width 0.5-5}, light.{color hex, intensity 0-40, distance 2-15}},
tide.{transmission 0-1, ior 1-2.3, thickness 0-3, attenuationColor hex, attenuationDistance 0.1-4},
vessels.{count 0-6, radius 0.03-0.2}, ring.{opacity 0-0.5, inner 0.3-0.7, outer 0.4-0.9}.`,
    scores: ["silhouette", "materials", "lighting", "teamIdentity", "flair", "overall"],
  },
  arena: {
    lookPath: "packages/web/src/world/arenaLook.json",
    views: ["/lab/arena?seed=3", "/lab/arena?seed=3&cam=low", "/lab/arena?seed=5&cam=high"],
    rubric: `You are the art director for a video game: a voice-driven dream-fight played in a 3D arena seen
from a slightly raised camera. The three images are the same playing field from the match camera, a low
angle, and a high angle (the third on a different seed). On the field: two team hearts (Ash, orange, right;
Tide, blue, left), three lanes between them drawn as lit ribbons, a tower per team per lane (dark obelisk,
floating team-coloured eye, faint range ring), small hooded minions walking the lanes, two player
creatures (placeholder shapes), and the obstacles creatures must walk around: rocks, stone pillars with a
glowing cap, crystal clusters, ruins, and glowing pools. The ground is an endless grid fading into fog.

Goal: a playing field that reads at a glance as a strategy arena with lanes and objectives, looks like a
polished indie game (moody, dreamlike, violet night, bloom), and where every kind of thing is
distinguishable: towers must not be confused with pillars, lanes must be visible but quiet, obstacles must
feel solid and part of one world, team sides must be obvious, the grid must support rather than shout.
Depth and atmosphere matter; so does legibility at the match camera.

Score 0-10 on: legibility, atmosphere, materials, composition, teamIdentity, overall.
Then propose parameter changes as a JSON object in the "patch" string (deep-merged into the file). Keep
every change justified by what you see. Change at most 10 leaves per round. Allowed keys and ranges:
grid.{cell 1-4, majorEvery 2-8, lineAlpha 0-0.4, farFade 0.005-0.06}, fogScale 0.2-1.5,
stars.{count 0-4000, factor 1-8, saturation 0-1}, lights.{ambient 0-2.5, hemisphere 0-2, sun 0-3, sunColor hex},
bloom.{intensity 0-2, threshold 0.2-1}, lane.{color hex, width 1-5, alpha 0-0.4, edgeAlpha 0-0.8},
rock.{color hex, roughness 0-1, emissive hex, emissiveIntensity 0-1}, pillar.{color hex, capColor hex, capIntensity 0-5, roughness 0-1},
crystal.{color hex, emissive hex, emissiveIntensity 0-4, opacity 0.3-1}, ruin.{color hex, roughness 0-1},
pool.{color hex, emissive hex, emissiveIntensity 0-3, rimAlpha 0-1}, tower.{bodyColor hex, roughness 0-1, eyeIntensity 0-8, lightIntensity 0-30, ringAlpha 0-1},
minion.{emissiveIntensity 0-3, roughness 0-1}.`,
    scores: ["legibility", "atmosphere", "materials", "composition", "teamIdentity", "overall"],
  },
};

const args = process.argv.slice(2);
const subjectName = args[0];
const subject = SUBJECTS[subjectName];
if (!subject) throw new Error(`usage: judge-look.mjs <${Object.keys(SUBJECTS).join("|")}> [rounds] [--web url]`);
const rounds = Number(args.slice(1).find((a) => /^\d+$/.test(a)) ?? 4);
const webIdx = args.indexOf("--web");
const web = webIdx >= 0 ? args[webIdx + 1] : "http://localhost:5173";
const lookPath = join(root, subject.lookPath);
const outDir = join(root, "scripts/out", subjectName);
mkdirSync(outDir, { recursive: true });

const client = new Anthropic();
const judgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "critique", "patch"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: subject.scores,
      properties: Object.fromEntries(subject.scores.map((k) => [k, { type: "number" }])),
    },
    critique: { type: "string" },
    patch: { type: "string", description: "JSON object text, deep-merged into the parameter file" },
  },
};

const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a?.[k] && typeof a[k] === "object" ? deepMerge(a[k], v) : v;
  }
  return out;
};

async function render(page, look, round) {
  const encoded = encodeURIComponent(Buffer.from(JSON.stringify(look)).toString("base64"));
  writeFileSync(join(outDir, `round-${round}.json`), JSON.stringify(look, null, 2));
  const images = [];
  for (const [i, view] of subject.views.entries()) {
    const sep = view.includes("?") ? "&" : "?";
    await page.goto(`${web}${view}${sep}look=${encoded}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
    const file = join(outDir, `round-${round}-${i}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 88 });
    images.push(readFileSync(file).toString("base64"));
  }
  return images;
}

async function judge(images, look, history) {
  const res = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2500,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: judgeSchema } },
    system: subject.rubric,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
          {
            type: "text",
            text: `Current parameters:\n${JSON.stringify(look)}\n\nPrevious rounds (score, critique):\n${history.map((h) => `- ${h.overall}: ${h.critique}`).join("\n") || "none"}\n\nScore these frames and propose the patch. Keep the critique under 120 words.`,
          },
        ],
      },
    ],
  });
  const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
  return { ...JSON.parse(text), usage: res.usage };
}

const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.error("page error:", e.message));

let look = JSON.parse(readFileSync(lookPath, "utf8"));
let best = { score: -1, look, round: 0 };
const history = [];
for (let round = 0; round <= rounds; round++) {
  const images = await render(page, look, round);
  let verdict;
  try {
    verdict = await judge(images, look, history);
  } catch (err) {
    console.error(`round ${round}: judge failed (${String(err.message).slice(0, 160)}), retrying once`);
    verdict = await judge(images, look, history);
  }
  const s = verdict.scores;
  const detail = subject.scores.filter((k) => k !== "overall").map((k) => `${k} ${s[k]}`).join(", ");
  console.log(`round ${round}: overall ${s.overall} (${detail}) in=${verdict.usage.input_tokens} out=${verdict.usage.output_tokens}`);
  console.log(`  ${verdict.critique}`);
  history.push({ overall: s.overall, critique: verdict.critique });
  if (s.overall > best.score) best = { score: s.overall, look, round };
  if (round === rounds) break;
  console.log(`  patch: ${verdict.patch}`);
  try {
    look = deepMerge(look, JSON.parse(verdict.patch || "{}"));
  } catch {
    console.error("  patch was not valid JSON, keeping the current look");
  }
}
await browser.close();
writeFileSync(lookPath, JSON.stringify(best.look, null, 2) + "\n");
console.log(`best: round ${best.round} (${best.score}); written to ${subject.lookPath}, frames in ${outDir}`);
