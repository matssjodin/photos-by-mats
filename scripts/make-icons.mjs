// Generates the PWA icon set in public/ from the brand camera mark.
// Run once after changing the brand: node scripts/make-icons.mjs
import fs from "node:fs/promises";
import sharp from "sharp";

const glyph = `
  <path d="M24 20l3-5h10l3 5h7a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3V23a3 3 0 0 1 3-3h7z" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/>
  <circle cx="32" cy="33" r="7.5" fill="none" stroke="#ffffff" stroke-width="3.5"/>`;

const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#102a2a"/>${glyph}</svg>`;
// Maskable/Apple: full-bleed background with the glyph inside the safe zone.
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#102a2a"/><g transform="translate(32 32) scale(0.78) translate(-32 -32)">${glyph}</g></svg>`;

await fs.mkdir("public/icons", { recursive: true });

const outputs = [
  { svg: rounded, size: 192, file: "public/icons/icon-192.png" },
  { svg: rounded, size: 512, file: "public/icons/icon-512.png" },
  { svg: fullBleed, size: 512, file: "public/icons/maskable-512.png" },
  { svg: fullBleed, size: 180, file: "public/apple-touch-icon.png" }
];

for (const { svg, size, file } of outputs) {
  await sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png().toFile(file);
  console.log(`wrote ${file}`);
}
