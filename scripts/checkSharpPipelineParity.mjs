// Direct before/after parity probe for the sharp-backed image pipelines
// (lib/avatarImage.ts, lib/logoImage.ts, lib/uploadSecurity.ts).
//
// Purpose: the sharp 0.34.5 -> 0.35.x upgrade is a documented breaking
// change, so "the build passed" is not evidence the pipeline still behaves
// the same. This calls the real processing functions on real generated
// images and prints deterministic metrics (format, dimensions, byte size,
// animated-frame detection, content-type verdicts). Run it BEFORE the
// upgrade to capture a baseline, then AFTER, and diff the two outputs.
//
// Deliberately does NOT touch Vercel Blob or /api/upload — this isolates the
// sharp behaviour itself, which is what the upgrade can actually change.
// (It also means it still runs while the Blob token is broken.)
//
// Run: npx tsx scripts/checkSharpPipelineParity.mjs > baseline.txt

import sharp from "sharp";

const { processAvatarImage, AVATAR_MAX_DIMENSION, AVATAR_TARGET_BYTES } = await import("../lib/avatarImage");
const { processLogoImage, LOGO_MAX_DIMENSION } = await import("../lib/logoImage");
const { verifyImageContent, safeUploadFilename } = await import("../lib/uploadSecurity");

console.log("sharp runtime version:", sharp.versions.sharp, "| libvips:", sharp.versions.vips);
console.log("AVATAR_MAX_DIMENSION:", AVATAR_MAX_DIMENSION, "| AVATAR_TARGET_BYTES:", AVATAR_TARGET_BYTES);
console.log("LOGO_MAX_DIMENSION:", LOGO_MAX_DIMENSION);
console.log("");

// Deterministic, high-entropy source images (noise compresses poorly, so the
// quality ladder actually gets exercised rather than short-circuiting).
function noise(w, h, seed = 1) {
  const px = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let i = 0; i < px.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; px[i] = s >> 16 & 0xff; }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
function flat(w, h, rgb) {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer();
}

const cases = [
  ["large noise 2400x1800", await noise(2400, 1800)],
  ["small flat 64x64", await flat(64, 64, { r: 200, g: 30, b: 60 })],
  ["wide 1600x400", await noise(1600, 400, 7)],
  ["tall 400x1600", await noise(400, 1600, 11)],
];

console.log("=== processAvatarImage ===");
for (const [label, buf] of cases) {
  const out = await processAvatarImage(buf);
  const md = await sharp(out.buffer).metadata();
  console.log(
    `  ${label.padEnd(24)} in=${buf.byteLength}B -> out=${out.buffer.byteLength}B ` +
    `fmt=${md.format} ${md.width}x${md.height} ct=${out.contentType} ` +
    `underTarget=${out.buffer.byteLength <= AVATAR_TARGET_BYTES}`
  );
}

console.log("\n=== processLogoImage (null = animated passthrough) ===");
for (const [label, buf] of cases) {
  const out = await processLogoImage(buf);
  if (!out) { console.log(`  ${label.padEnd(24)} -> null (passthrough)`); continue; }
  const md = await sharp(out.buffer).metadata();
  console.log(
    `  ${label.padEnd(24)} in=${buf.byteLength}B -> out=${out.buffer.byteLength}B ` +
    `fmt=${md.format} ${md.width}x${md.height} ct=${out.contentType}`
  );
}

console.log("\n=== animated GIF handling (must stay passthrough) ===");
{
  // Real single-frame and multi-frame GIFs, generated here so the check is
  // self-contained and can't rot against a hardcoded blob. A multi-page GIF
  // is built filmstrip-style: pageHeight inside the raw input options is what
  // actually makes sharp emit multiple pages (pageHeight at the top level
  // silently produces a 1-page GIF).
  const frames = await sharp({
    create: { width: 32, height: 64, channels: 3, background: { r: 10, g: 200, b: 90 } },
  }).gif().toBuffer();
  const NF = 3, GW = 32, GPH = 64;
  const strip = Buffer.alloc(GW * GPH * NF * 3);
  for (let f = 0; f < NF; f++) strip.fill(60 + f * 70, f * GW * GPH * 3, (f + 1) * GW * GPH * 3);
  const animated = await sharp(strip, {
    raw: { width: GW, height: GPH * NF, channels: 3, pageHeight: GPH },
  }).gif({ loop: 0 }).toBuffer();
  for (const [label, buf] of [["single-frame GIF", frames], ["3-frame animated GIF", animated]]) {
    const md = await sharp(buf, { animated: true }).metadata();
    const out = await processLogoImage(buf);
    console.log(`  ${label.padEnd(24)} pages=${md.pages ?? 1} -> processLogoImage=${out ? "resized" : "null (passthrough)"}`);
  }
}

console.log("\n=== verifyImageContent (security gate — format from bytes) ===");
{
  const png = await flat(8, 8, { r: 1, g: 2, b: 3 });
  const jpeg = await sharp(png).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const gif = await sharp(png).gif().toBuffer();
  const tiff = await sharp(png).tiff().toBuffer();
  const samples = [
    ["png", png], ["jpeg", jpeg], ["webp", webp], ["gif", gif],
    ["tiff (must be REJECTED)", tiff],
    ["html bytes (must be REJECTED)", Buffer.from("<html><script>alert(1)</script></html>")],
    ["empty (must be REJECTED)", Buffer.alloc(0)],
    ["svg (must be REJECTED)", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
  ];
  for (const [label, buf] of samples) {
    const v = await verifyImageContent(buf);
    console.log(`  ${label.padEnd(30)} -> ${v ? `${v.format} .${v.extension} ${v.contentType}` : "REJECTED"}`);
  }
}

console.log("\n=== safeUploadFilename (pure, sharp-independent) ===");
for (const n of ["photo.png", "../../etc/passwd.png", "a\\b\\c.html", "  spaces & symbols!.jpeg", "", "..", "x".repeat(200) + ".png"]) {
  console.log(`  ${JSON.stringify(n).padEnd(34)} -> ${JSON.stringify(safeUploadFilename(n, "webp"))}`);
}
