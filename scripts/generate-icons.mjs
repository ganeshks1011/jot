import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZES = [16, 32, 48, 128];
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icon");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mix(from, to, t) {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

// Rounded-square icon: indigo→violet gradient background + white four-point
// sparkle (the same mark as the overlay header).
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const from = [99, 102, 241]; // indigo-500
  const to = [139, 92, 246]; // violet-500
  const cx = size / 2;
  const cy = size / 2;

  const sparklePoints = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
    sparklePoints.push({ x: cx + Math.cos(angle) * size * 0.32, y: cy + Math.sin(angle) * size * 0.32 });
    sparklePoints.push({
      x: cx + Math.cos(angle + Math.PI / 4) * size * 0.11,
      y: cy + Math.sin(angle + Math.PI / 4) * size * 0.11,
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      // Rounded-corner alpha.
      const nearRight = x >= size - radius;
      const nearBottom = y >= size - radius;
      const nearLeft = x < radius;
      const nearTop = y < radius;
      let a = 1;
      if (nearRight && nearTop) {
        const d = Math.hypot(x - (size - radius), y - radius);
        a = d <= radius ? 1 : 0;
      } else if (nearRight && nearBottom) {
        const d = Math.hypot(x - (size - radius), y - (size - radius));
        a = d <= radius ? 1 : 0;
      } else if (nearLeft && nearTop) {
        const d = Math.hypot(x - radius, y - radius);
        a = d <= radius ? 1 : 0;
      } else if (nearLeft && nearBottom) {
        const d = Math.hypot(x - radius, y - (size - radius));
        a = d <= radius ? 1 : 0;
      }
      if (a === 0) continue;

      const t = (x + y) / (2 * size);
      const [r, g, b] = mix(from, to, t);

      // Four-point star (two rotated squares / diamond lobes) via point-in-star
      // test: inside if within a rotated diamond whose half-width shrinks away
      // from the axis.
      const dist = Math.hypot(dx, dy);
      const inStar = dist <= size * 0.32 && dist > 0 && Math.abs(Math.cos(Math.atan2(dy, dx) * 4)) > 0.62;
      const sparkleColor = [255, 255, 255];
      const finalColor = inStar ? sparkleColor : [r, g, b];
      buf[i] = clamp(finalColor[0], 0, 255);
      buf[i + 1] = clamp(finalColor[1], 0, 255);
      buf[i + 2] = clamp(finalColor[2], 0, 255);
      buf[i + 3] = a === 1 ? 255 : Math.round(a * 255);
    }
  }
  return buf;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const rgba = draw(size);
  writeFileSync(resolve(OUT_DIR, `icon${size}.png`), encodePng(size, size, rgba));
  console.log(`wrote public/icon/icon${size}.png`);
}
