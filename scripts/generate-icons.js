/**
 * Regenerate every app icon from the canonical brand SVG.
 *
 *   node scripts/generate-icons.js
 *
 * Source:  branding/zehen-icon.svg  (pure vector paths, no fonts)
 * Outputs:
 *   build/icon.ico      — electron-builder: installer + .exe resource
 *   electron/icon.ico   — BrowserWindow icon at runtime (main.js)
 *   build/icon.png      — 256×256 PNG
 *   build/icon-512.png  — 512×512 PNG
 *   build/icon.svg      — copy of the source SVG
 *
 * The .ico embeds PNG-compressed entries at 16–256 px (same layout the
 * png-to-ico package produces; supported since Vista, required ≥256 px
 * by electron-builder).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'branding', 'zehen-icon.svg');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(pngs) {
  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) per image + PNG blobs
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
    e.writeUInt8(0, 2);  // palette colours
    e.writeUInt8(0, 3);  // reserved
    e.writeUInt16LE(1, 4);  // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.buf)]);
}

(async () => {
  const svg = fs.readFileSync(SRC);
  // density bump so librsvg rasterises crisply before downscale
  const png = (size) => sharp(svg, { density: 288 }).resize(size, size).png().toBuffer();

  const pngs = [];
  for (const size of ICO_SIZES) pngs.push({ size, buf: await png(size) });
  const ico = buildIco(pngs);

  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
  fs.writeFileSync(path.join(ROOT, 'electron', 'icon.ico'), ico);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), await png(256));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon-512.png'), await png(512));
  fs.copyFileSync(SRC, path.join(ROOT, 'build', 'icon.svg'));

  console.log(`icon.ico: ${ico.length} bytes, ${pngs.length} sizes (${ICO_SIZES.join(', ')})`);
  console.log('Wrote build/icon.ico, electron/icon.ico, build/icon.png, build/icon-512.png, build/icon.svg');
})().catch((e) => { console.error(e); process.exit(1); });
