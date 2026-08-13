/**
 * Generate the PWA icon set as PNGs, with no image-library dependency.
 *
 * The mark is a checkmark on the app's accent colour — deliberately simple,
 * because a maskable icon gets cropped to a circle on many launchers and
 * detail near the edges is lost anyway.
 *
 *   node shared/scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [59, 130, 246];      // --accent #3b82f6
const FG = [255, 255, 255];

/** CRC32, needed for PNG chunks. */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {number} size
 * @param {boolean} maskable  pad the mark so a circular crop cannot clip it
 */
function makeIcon(size, maskable) {
  const px = (x, y) => {
    // Rounded-square background, or full bleed for maskable.
    const r = maskable ? 0 : size * 0.22;
    const inCorner =
      (x < r && y < r && (x - r) ** 2 + (y - r) ** 2 > r * r) ||
      (x > size - r && y < r && (x - (size - r)) ** 2 + (y - r) ** 2 > r * r) ||
      (x < r && y > size - r && (x - r) ** 2 + (y - (size - r)) ** 2 > r * r) ||
      (x > size - r && y > size - r &&
        (x - (size - r)) ** 2 + (y - (size - r)) ** 2 > r * r);
    if (inCorner) return [0, 0, 0, 0];

    // Checkmark: two strokes, inset further on maskable icons.
    const inset = maskable ? 0.30 : 0.22;
    const s = size;
    const nx = x / s;
    const ny = y / s;
    const w = maskable ? 0.055 : 0.07;

    // Short stroke: (0.30,0.52) -> (0.44,0.66);  long: (0.44,0.66) -> (0.72,0.36)
    const near = (ax, ay, bx, by) => {
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((nx - ax) * dx + (ny - ay) * dy) / (dx * dx + dy * dy)));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      return Math.hypot(nx - cx, ny - cy) < w;
    };

    const pad = (inset - 0.22) * 0.5;
    const on = near(0.30 + pad, 0.52, 0.44 + pad, 0.66) ||
               near(0.44 + pad, 0.66, 0.72 - pad, 0.36);

    return on ? [...FG, 255] : [...BG, 255];
  };

  // Raw scanlines, each prefixed with filter type 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x + 0.5, y + 0.5);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  const png = makeIcon(size, maskable);
  writeFileSync(join(outDir, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}
