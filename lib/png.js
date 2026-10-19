// Minimal PNG encoder (8-bit gray / gray+alpha / RGBA) with per-row adaptive filtering.
// Canvas can only export 32-bit RGBA PNGs; grayscale masks and patterns are 3-4x
// smaller written this way. Uses CompressionStream('deflate') (zlib), DOM-free.

import { concat, crc32, enc } from './bytes.js';

const COLOR_TYPE = { 1: 0, 2: 4, 4: 6 };

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Encode {width, height, data} where data has `channels` bytes per pixel (1, 2 or 4). */
export async function encodePng({ width, height, data }, channels) {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y ? data.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[i] - pred) & 0xFF;
        o[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // Recompute the winner fully (the scoring loop may have stopped early).
    const o = cand[best];
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      const pred = best === 0 ? 0 : best === 1 ? a : best === 2 ? b : best === 3 ? (a + b) >> 1 : paeth(a, b, c);
      o[i] = (cur[i] - pred) & 0xFF;
    }
    raw[y * (stride + 1)] = best;
    raw.set(o, y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr.set([8, COLOR_TYPE[channels], 0, 0, 0], 8);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Gray mask -> RGBA PNG of black ink with alpha = mask (what Krita reads as an alpha-mask tip). */
export function maskPng(mask) {
  const n = mask.width * mask.height, px = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) px[i * 4 + 3] = mask.data[i];
  return encodePng({ width: mask.width, height: mask.height, data: px }, 4);
}

/** Gray buffer -> 8-bit grayscale PNG. */
export function grayPng(gray) {
  return encodePng(gray, 1);
}
