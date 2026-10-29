// AI art director for the 3D hearts. Renders /lab/hearts with Playwright, shows the frame to Claude
// with a rubric, applies the parameter tweaks it proposes to heartLook.json, and repeats, keeping the
// best-scoring look. Usage: node scripts/judge-hearts.mjs [rounds=4] [--web http://localhost:5173]
// Reads ANTHROPIC_API_KEY from the environment or the repo's .env. Costs a few cents per round.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (!process.env.ANTHROPIC_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

const args = process.argv.slice(2);
const rounds = Number(args.find((a) => /^\d+$/.test(a)) ?? 4);
const webIdx = args.indexOf("--web");
const web = webIdx >= 0 ? args[webIdx + 1] : "http://localhost:5173";
const lookPath = join(root, "packages/web/src/world/heart3d/heartLook.json");
const outDir = join(root, "scripts/out/hearts");
mkdirSync(outDir, { recursive: true });

const RUBRIC = `You are the art director for a video game. The image shows two team hearts in the arena of a
voice-driven dream-fight game: Ash (left, fire and iron) and Tide (right, ice and deep water). They are
rendered live in WebGL from a parameter file. Goal: "super real" video-game hearts with artistic flair.
Think anatomical mass and weight, wet or crystalline surfaces, light that comes from inside, veins that
read as alive, vessels on top, a silhouette that is unmistakably a heart from 10 metres away, team colour
readable at a glance, nothing that looks like a toy valentine, a blob, or a flat sticker.

Score 0-10 on: silhouette, materials (realism), lighting/glow, team identity, flair, overall.
Then propose parameter changes as a JSON object in the "patch" string (deep-merged into the file). Keep every change
justified by what you see. Change at most 8 leaves per round. Allowed keys and ranges:
resolution 32-64 (mesh detail), scale 0.6-1.4, shape.{lobe 0.5-1.2 (lower = wider lobes), thickness 0.5-1.1}, pulse.{base 1-4, weakBoost 0-5, amount 0.02-0.2, sharpness 2-12},
float.{amplitude 0-0.3, speed 0.2-2}, rotateSpeed 0-1,
ash/tide.{color hex, emissive hex, emissiveIntensity 0-4, roughness 0-1, metalness 0-1, clearcoat 0-1,
clearcoatRoughness 0-1, bumpScale 0-0.08 (surface relief from the vein pattern), veins.{color hex, density 0-1.5, width 0.5-5}, light.{color hex, intensity 0-40, distance 2-15}},
tide.{transmission 0-1, ior 1-2.3, thickness 0-3, attenuationColor hex, attenuationDistance 0.1-4},
vessels.{count 0-6, radius 0.03-0.2}, ring.{opacity 0-0.5 (floor glow strength), inner 0.3-0.7, outer 0.4-0.9}.`;

const client = new Anthropic();
const judgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "critique", "patch"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: ["silhouette", "materials", "lighting", "teamIdentity", "flair", "overall"],
      properties: Object.fromEntries(
        ["silhouette", "materials", "lighting", "teamIdentity", "flair", "overall"].map((k) => [k, { type: "number" }]),
      ),
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

async function render(page, look, file) {
  const encoded = encodeURIComponent(Buffer.from(JSON.stringify(look)).toString("base64"));
  await page.goto(`${web}/lab/hearts?still=1&look=${encoded}`, { waitUntil: "networkidle" });
  writeFileSync(file.replace(/.jpg$/, ".json"), JSON.stringify(look, null, 2));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: file, type: "jpeg", quality: 88 });
  return readFileSync(file).toString("base64");
}

async function judge(imageB64, look, history) {
  const res = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 1500,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: judgeSchema } },
    system: RUBRIC,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } },
          {
            type: "text",
            text: `Current parameters:\n${JSON.stringify(look)}\n\nPrevious rounds (score, critique):\n${history.map((h) => `- ${h.overall}: ${h.critique}`).join("\n") || "none"}\n\nScore this frame and propose the patch.`,
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
  const file = join(outDir, `round-${round}.jpg`);
  const img = await render(page, look, file);
  let verdict;
  try {
    verdict = await judge(img, look, history);
  } catch (err) {
    console.error(`round ${round}: judge failed (${err.message?.slice(0, 160)}), retrying once`);
    verdict = await judge(img, look, history);
  }
  const s = verdict.scores;
  console.log(
    `round ${round}: overall ${s.overall} (silhouette ${s.silhouette}, materials ${s.materials}, light ${s.lighting}, team ${s.teamIdentity}, flair ${s.flair}) in=${verdict.usage.input_tokens} out=${verdict.usage.output_tokens}`,
  );
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
console.log(`best: round ${best.round} (${best.score}); written to heartLook.json, frames in ${outDir}`);
