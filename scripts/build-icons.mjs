/**
 * Renders the extension icons (src/icons/icon-*.png) from simple shapes, so
 * the artwork lives in code and needs no image tools. Run: npm run icons
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

/** Icon size -> transparent padding. The store asks for 96px art inside 128px. */
const SIZES = { 16: 0, 32: 1, 48: 2, 128: 16 };
const OUT_DIR = new URL('../src/icons/', import.meta.url);
/** Per-axis supersampling for anti-aliased edges. */
const SAMPLES = 8;

const ACCENT = [0x5b, 0x5b, 0xd6];
const WHITE = [0xff, 0xff, 0xff];

/** A horizontal fader, painted back to front in a 0..1 box. */
const LAYERS = [
  { color: ACCENT, alpha: 1, inside: (x, y) => roundedRect(x, y, 0.22) },
  { color: WHITE, alpha: 0.45, inside: (x, y) => capsule(x, y, 0.2, 0.8, 0.5, 0.06) },
  { color: WHITE, alpha: 1, inside: (x, y) => capsule(x, y, 0.2, 0.6, 0.5, 0.06) },
  { color: WHITE, alpha: 1, inside: (x, y) => circle(x, y, 0.6, 0.5, 0.15) },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [size, padding] of Object.entries(SIZES)) {
  const file = new URL(`icon-${size}.png`, OUT_DIR);
  writeFileSync(file, encodePng(render(Number(size), padding), Number(size)));
  console.log(`icons/icon-${size}.png`);
}

/**
 * @param {number} size
 * @param {number} padding
 * @returns {Uint8Array} RGBA pixels.
 */
function render(size, padding) {
  const pixels = new Uint8Array(size * size * 4);
  const art = size - padding * 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Premultiplied accumulation over the subsamples.
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px - padding + (sx + 0.5) / SAMPLES) / art;
          const y = (py - padding + (sy + 0.5) / SAMPLES) / art;
          let [cr, cg, cb, ca] = [0, 0, 0, 0];
          for (const layer of LAYERS) {
            if (!layer.inside(x, y)) continue;
            const la = layer.alpha;
            cr = layer.color[0] * la + cr * (1 - la);
            cg = layer.color[1] * la + cg * (1 - la);
            cb = layer.color[2] * la + cb * (1 - la);
            ca = la + ca * (1 - la);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = SAMPLES * SAMPLES;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      pixels[i] = alpha ? Math.round(r / n / alpha) : 0;
      pixels[i + 1] = alpha ? Math.round(g / n / alpha) : 0;
      pixels[i + 2] = alpha ? Math.round(b / n / alpha) : 0;
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function roundedRect(x, y, radius) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const dx = Math.max(radius - x, x - (1 - radius), 0);
  const dy = Math.max(radius - y, y - (1 - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

function capsule(x, y, x0, x1, cy, halfWidth) {
  const dx = x - Math.min(Math.max(x, x0), x1);
  const dy = y - cy;
  return dx * dx + dy * dy <= halfWidth * halfWidth;
}

function circle(x, y, cx, cy, radius) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

/**
 * Minimal PNG encoder: 8-bit RGBA, no filtering.
 * @param {Uint8Array} pixels
 * @param {number} size
 */
function encodePng(pixels, size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1);
    rows[offset] = 0;
    rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), offset + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // bit depth, RGBA, compression, filter, interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
