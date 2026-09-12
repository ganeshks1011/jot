// Generates a white-on-transparent version of the Jot wordmark from
// design/jot_logo_cutout.png:
//   - public/icon/logo-white.png   (512px wide, cropped to the mark)
//   - design/jot_logo_white.png    (full-res master)
// The colored background is intentionally NOT baked in — UI wraps the mark
// in a CSS gradient chip instead. Toolbar icons stay untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "design/jot_logo_cutout.png");
const MASTER_OUT = resolve(ROOT, "design/jot_logo_white.png");
const ICON_OUT = resolve(ROOT, "public/icon/logo-white.png");
const TARGET_WIDTH = 512;

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

function decodeRgbaPng(path) {
  const b = readFileSync(path);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let off = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") {
      w = b.readUInt32BE(off + 8);
      h = b.readUInt32BE(off + 12);
      const bitDepth = b.readUInt8(off + 16);
      const colorType = b.readUInt8(off + 17);
      const interlace = b.readUInt8(off + 20);
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`${path}: unsupported PNG (depth=${bitDepth} color=${colorType} interlace=${interlace})`);
      }
    } else if (type === "IDAT") {
      idat.push(b.subarray(off + 8, off + 8 + len));
    }
    off += len + 12;
  }
  const stride = w * 4;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * h) throw new Error(`${path}: unexpected IDAT size`);
  const data = Buffer.alloc(w * h * 4);
  const paeth = (a, b2, c) => {
    const p = a + b2 - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b2);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= 4 ? data[i - 4] : 0;
      const up = y > 0 ? data[i - stride] : 0;
      const upLeft = y > 0 && x >= 4 ? data[i - stride - 4] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      data[i] = v & 255;
    }
  }
  return { width: w, height: h, data };
}

const src = decodeRgbaPng(SRC);

// Bounding box of visible pixels.
let minx = src.width;
let maxx = -1;
let miny = src.height;
let maxy = -1;
for (let y = 0; y < src.height; y++) {
  for (let x = 0; x < src.width; x++) {
    if (src.data[(y * src.width + x) * 4 + 3] > 0) {
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  }
}
if (maxx < 0) throw new Error("source has no visible pixels");

// Small margin so anti-aliased edges survive the crop and downscale.
const margin = Math.round(Math.max(maxx - minx, maxy - miny) * 0.02);
minx = Math.max(0, minx - margin);
miny = Math.max(0, miny - margin);
maxx = Math.min(src.width - 1, maxx + margin);
maxy = Math.min(src.height - 1, maxy + margin);
const cropW = maxx - minx + 1;
const cropH = maxy - miny + 1;

// Full-res master: white RGB, source alpha preserved.
const master = Buffer.alloc(cropW * cropH * 4);
for (let y = 0; y < cropH; y++) {
  for (let x = 0; x < cropW; x++) {
    const si = ((y + miny) * src.width + (x + minx)) * 4;
    const di = (y * cropW + x) * 4;
    master[di] = 255;
    master[di + 1] = 255;
    master[di + 2] = 255;
    master[di + 3] = src.data[si + 3];
  }
}
writeFileSync(MASTER_OUT, encodePng(cropW, cropH, master));

// Box-filter downscale on premultiplied alpha to avoid dark fringes.
const outW = TARGET_WIDTH;
const outH = Math.round((cropH / cropW) * TARGET_WIDTH);
const icon = Buffer.alloc(outW * outH * 4);
for (let ty = 0; ty < outH; ty++) {
  const y0 = Math.floor((ty * cropH) / outH);
  const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * cropH) / outH));
  for (let tx = 0; tx < outW; tx++) {
    const x0 = Math.floor((tx * cropW) / outW);
    const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * cropW) / outW));
    let sumA = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const a = master[(y * cropW + x) * 4 + 3];
        sumA += a;
        sumR += 255 * a;
        sumG += 255 * a;
        sumB += 255 * a;
      }
    }
    const di = (ty * outW + tx) * 4;
    if (sumA === 0) {
      icon[di] = 255;
      icon[di + 1] = 255;
      icon[di + 2] = 255;
      icon[di + 3] = 0;
    } else {
      icon[di] = Math.round(sumR / sumA);
      icon[di + 1] = Math.round(sumG / sumA);
      icon[di + 2] = Math.round(sumB / sumA);
      icon[di + 3] = Math.round(sumA / ((x1 - x0) * (y1 - y0)));
    }
  }
}
writeFileSync(ICON_OUT, encodePng(outW, outH, icon));

console.log(`wrote ${MASTER_OUT} (${cropW}x${cropH})`);
console.log(`wrote ${ICON_OUT} (${outW}x${outH})`);
