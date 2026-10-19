// Photoshop patterns, as stored in an .abr 'patt' section (the same records as a .pat
// file): a header, then the pixels as a "virtual memory array list" of channels. DOM-free.

import { readRows, toEightBit } from './stream.js';

const MODES = { 1: 'grayscale', 2: 'indexed', 3: 'RGB', 4: 'CMYK', 7: 'multichannel', 8: 'duotone', 9: 'Lab' };

/**
 * One pattern record at `cur`. Returns {id, name, image: {width, height, data: RGBA}}, or
 * {id, name, image: null, warning} for colour modes we can't show.
 */
export function readPattern(cur) {
  const length = (cur.u32() + 3) & ~3; // records are padded to 4 bytes
  const rec = cur.sub(Math.min(length, cur.left));
  const version = rec.u32();
  if (version !== 1) throw new Error(`pattern version ${version}`);
  const mode = rec.u32();
  rec.skip(4); // height, width as i16 (the VMAL rectangle has them too)
  const name = rec.unicode();
  const id = rec.pascal();
  if (![1, 2, 3].includes(mode)) {
    return { id, name, image: null, warning: `pattern '${name}' is in ${MODES[mode] || `mode ${mode}`} colour, which isn't supported` };
  }
  let palette = null;
  if (mode === 2) {
    palette = rec.bytes(256 * 3);
    rec.skip(4); // palette size and transparent index
  }

  const vmal = rec.u32();
  if (vmal !== 3) throw new Error(`pattern '${name}': memory list version ${vmal}`);
  rec.u32(); // length
  const top = rec.i32(), left = rec.i32(), bottom = rec.i32(), right = rec.i32();
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0 || width * height > 1 << 26) throw new Error(`pattern '${name}': bad size ${width}x${height}`);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const wanted = mode === 3 ? 3 : 1;
  // The channel count excludes the user and sheet masks, which follow the colour channels.
  const count = rec.u32() + 2;
  for (let i = 0, ch = 0; i < count && ch < wanted; i++) {
    if (!rec.u32()) continue; // channel not written
    const chan = rec.sub(rec.u32());
    const depth = chan.u32();
    const ct = chan.i32(), cl = chan.i32(), cb = chan.i32(), cr = chan.i32();
    chan.u16(); // depth again
    const compression = chan.u8();
    const w = cr - cl, h = cb - ct;
    const pixels = toEightBit(readRows(chan, h, w * (depth >> 3), compression), depth);
    for (let y = 0; y < h; y++) {
      const ty = y + ct - top;
      if (ty < 0 || ty >= height) continue;
      for (let x = 0; x < w; x++) {
        const tx = x + cl - left;
        if (tx < 0 || tx >= width) continue;
        const v = pixels[y * w + x], o = (ty * width + tx) * 4;
        if (palette) data.set(palette.subarray(v * 3, v * 3 + 3), o);
        else if (mode === 1) data[o] = data[o + 1] = data[o + 2] = v;
        else data[o + ch] = v;
      }
    }
    ch++;
  }
  return { id, name, image: { width, height, data } };
}

/** Every pattern in a 'patt' section. Returns {patterns: Map(id -> pattern), warnings}. */
export function readPatterns(cur) {
  const patterns = new Map(), warnings = [];
  while (cur.left >= 4) {
    try {
      const p = readPattern(cur);
      if (p.warning) warnings.push(p.warning);
      patterns.set(p.id, p);
    } catch (e) {
      warnings.push(`pattern skipped: ${e.message}`); // readPattern has moved past the record
    }
  }
  return { patterns, warnings };
}

/** Photoshop's preset patterns are named like '$$$/Presets/Patterns/…/GrayGranite=Gray Granite'. */
export function patternName(name) {
  return name.startsWith('$$$/') && name.includes('=') ? name.slice(name.indexOf('=') + 1) : name;
}
