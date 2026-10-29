// One-off: paint the two team hearts with fal and save them as static client assets, so the game
// never pays for a heart picture again. Reads FAL_KEY / FAL_API_KEY from .env.
//   node scripts/paint-hearts.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fal } from "@fal-ai/client";

process.loadEnvFile(new URL("../.env", import.meta.url));
const key = process.env.FAL_KEY || process.env.FAL_API_KEY;
if (!key) throw new Error("no FAL key in .env");
fal.config({ credentials: key });

const STYLE =
  "sticker illustration, single subject centered, full body visible, dramatic rim light, painterly dreamlike detail, isolated on a flat uniform solid magenta #ff00ff chroma-key background, no floor, no shadow, no pink or magenta on the subject, no text, no watermark";
const HEARTS = {
  ash: "a colossal anatomical heart carved from molten amber and black iron, veins of fire, floating, dramatic orange rim light",
  tide: "a colossal anatomical heart carved from deep blue glacial ice, dark navy frost veins, cold white highlights, floating, hard cyan rim light, no glow, no halo",
};

mkdirSync(new URL("../packages/web/public/hearts/", import.meta.url), { recursive: true });
const only = process.argv[2];
for (const [team, prompt] of Object.entries(HEARTS)) {
  if (only && team !== only) continue;
  const result = await fal.subscribe("fal-ai/flux/schnell", {
    input: { prompt: `${prompt}, ${STYLE}`, image_size: "square", num_inference_steps: 4, num_images: 1, enable_safety_checker: true },
  });
  const img = result.data.images?.[0];
  if (!img?.url) throw new Error(`no image for ${team}`);
  const bytes = Buffer.from(await (await fetch(img.url)).arrayBuffer());
  const out = new URL(`../packages/web/public/hearts/${team}.jpg`, import.meta.url);
  writeFileSync(out, bytes);
  console.log(`${team}: ${bytes.length} bytes -> packages/web/public/hearts/${team}.jpg`);
}
