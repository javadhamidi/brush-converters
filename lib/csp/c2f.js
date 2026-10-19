// Decoder for the image data inside Clip Studio Paint material layers.
// JavaScript port of python/sut2krita/c2f.py; see docs/csp-internals.md.
//
// Each MaterialFile.FileData blob is a tar archive holding data/material*.layer
// plus thumbnail/thumbnail.png. A .layer file is a "C2F" container whose dATA
// chunks form a SQLite database (4096-byte pages). The first 5120 bytes are
// encrypted, so we walk the plaintext table-leaf pages directly and decode the
// Offscreen rows: an attribute blob (size, 256x256 block grid) and zlib tiles.

import { decodeUtf16 } from '../bytes.js';
import { inflate } from '../inflate.js';
import { parseTar } from '../tar.js';

export const C2F_MAGIC = [0x89, 0x43, 0x32, 0x46, 0x0D, 0x0A, 0x1A, 0x0A];
const PAGE_SIZE = 4096;
const BLOCK_BEGIN = 'BlockDataBeginChunk';
const PARAMETER = 'Parameter';

class LayerDecodeError extends Error {}

const latin = (b) => String.fromCharCode(...b);
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** SQLite bytes inside a C2F container, with the encrypted chunks zeroed. */
export function c2fDatabase(data) {
  if (data.length < 8 || C2F_MAGIC.some((v, i) => data[i] !== v)) {
    throw new LayerDecodeError('not a C2F layer file');
  }
  const parts = [];
  let total = 0;
  let i = 8;
  while (i + 8 <= data.length) {
    const length = u32le(data, i);
    const ctype = latin(data.subarray(i + 4, i + 8));
    const body = data.subarray(i + 8, i + 8 + length);
    i += 12 + length;
    if (ctype !== 'dATA' || body.length < 2) continue;
    // Flag 0: plaintext after 2 bytes. Otherwise 2-byte flag + 8-byte nonce + ciphertext.
    const part = body[0] === 0 ? body.subarray(2) : new Uint8Array(Math.max(0, body.length - 10));
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function varint(buf, i) {
  let value = 0n;
  for (let k = 0; k < 9; k++) {
    const byte = buf[i + k];
    if (byte === undefined) throw new LayerDecodeError('bad varint');
    if (k === 8) return [Number((value << 8n) | BigInt(byte)), i + 9];
    value = (value << 7n) | BigInt(byte & 0x7F);
    if (!(byte & 0x80)) return [Number(value), i + k + 1];
  }
  throw new LayerDecodeError('bad varint');
}

function cellPayload(db, page, offset) {
  let [size, i] = varint(page, offset);
  [, i] = varint(page, i); // rowid
  const maxLocal = PAGE_SIZE - 35;
  if (size <= maxLocal) return page.subarray(i, i + size);
  const minLocal = Math.floor(((PAGE_SIZE - 12) * 32) / 255) - 23;
  let local = minLocal + ((size - minLocal) % (PAGE_SIZE - 4));
  if (local > maxLocal) local = minLocal;
  const out = new Uint8Array(size);
  out.set(page.subarray(i, i + local));
  let filled = Math.min(local, size);
  let next = u32be(page, i + local);
  const seen = new Set();
  while (next && filled < size && !seen.has(next)) {
    seen.add(next);
    const start = (next - 1) * PAGE_SIZE;
    if (start + PAGE_SIZE > db.length) break;
    next = u32be(db, start);
    const chunk = db.subarray(start + 4, start + PAGE_SIZE);
    const take = Math.min(chunk.length, size - filled);
    out.set(chunk.subarray(0, take), filled);
    filled += take;
  }
  return out.subarray(0, filled);
}

const utf8 = new TextDecoder('utf-8');

function decodeRecord(rec) {
  let [headerLen, i] = varint(rec, 0);
  const types = [];
  while (i < headerLen) {
    let t;
    [t, i] = varint(rec, i);
    types.push(t);
  }
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const values = [];
  let j = headerLen;
  for (const t of types) {
    if (t === 0) values.push(null);
    else if (t >= 1 && t <= 6) {
      const n = [0, 1, 2, 3, 4, 6, 8][t];
      if (j + n > rec.length) throw new LayerDecodeError('truncated record');
      let v = 0n;
      for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(rec[j + k]);
      if (rec[j] & 0x80) v -= 1n << BigInt(8 * n);
      values.push(Number(v));
      j += n;
    } else if (t === 7) {
      values.push(dv.getFloat64(j, false));
      j += 8;
    } else if (t === 8 || t === 9) values.push(t - 8);
    else if (t >= 12) {
      const n = (t - 12) >> 1;
      const raw = rec.subarray(j, j + n);
      j += n;
      values.push(t % 2 === 0 ? raw : utf8.decode(raw));
    } else throw new LayerDecodeError('reserved serial type');
  }
  return values;
}

/** Decoded records from every readable table-leaf page. */
export function* iterRows(db) {
  const pages = Math.floor(db.length / PAGE_SIZE);
  for (let p = 2; p <= pages; p++) {
    const page = db.subarray((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
    if (page[0] !== 0x0D) continue;
    const cells = (page[3] << 8) | page[4];
    for (let c = 0; c < cells; c++) {
      const offset = (page[8 + 2 * c] << 8) | page[9 + 2 * c];
      if (offset < 8 || offset >= PAGE_SIZE) break;
      let values;
      try {
        values = decodeRecord(cellPayload(db, page, offset));
      } catch (e) {
        continue;
      }
      yield values;
    }
  }
}

function isOffscreenAttr(v) {
  return v instanceof Uint8Array && v.length > 54 && u32be(v, 0) === 0x10 && u32be(v, 16) === 9
    && decodeUtf16(v.subarray(20, 38), false) === PARAMETER;
}

function pasteBlock(img, W, x, y, w, h, raw) {
  const n = w * h;
  let get;
  if (raw.length >= n * 5) {
    get = (p) => [raw[n + p * 4 + 2], raw[n + p * 4 + 1], raw[n + p * 4], raw[p]];
  } else if (raw.length >= n * 2) {
    get = (p) => { const g = raw[n + p]; return [g, g, g, raw[p]]; };
  } else if (raw.length >= n >> 2) {
    // 1-bit alpha plane followed by a 1-bit tone plane, MSB first.
    const bit = (base, p) => ((raw[base + (p >> 3)] >> (7 - (p & 7))) & 1) * 255;
    get = (p) => { const g = bit(n >> 3, p); return [g, g, g, bit(0, p)]; };
  } else if (raw.length >= n) {
    get = (p) => [0, 0, 0, raw[p]];
  } else return false;
  for (let row = 0; row < h; row++) {
    let d = ((y + row) * W + x) * 4;
    for (let col = 0; col < w; col++, d += 4) {
      const px = get(row * w + col);
      img[d] = px[0]; img[d + 1] = px[1]; img[d + 2] = px[2]; img[d + 3] = px[3];
    }
  }
  return true;
}

/** Offscreen attribute + block data -> {width, height, data: RGBA, filled}. */
export async function decodeOffscreen(attr, blocks) {
  const width = u32be(attr, 38), height = u32be(attr, 42);
  const gw = u32be(attr, 46), gh = u32be(attr, 50);
  if (!(width > 0 && width <= 20000 && height > 0 && height <= 20000 && gw && gh)) {
    throw new LayerDecodeError('implausible offscreen size');
  }
  const W = gw * 256, H = gh * 256;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < img.length; p += 4) { img[p] = img[p + 1] = img[p + 2] = 255; }
  let filled = 0;
  let i = 0;
  while (i + 8 <= blocks.length) {
    const chunkLen = u32be(blocks, i);
    if (u32be(blocks, i + 4) !== BLOCK_BEGIN.length) break; // BlockStatus / BlockCheckSum trailer
    const j = i + 8 + 2 * BLOCK_BEGIN.length;
    if (decodeUtf16(blocks.subarray(i + 8, j), false) !== BLOCK_BEGIN) break;
    const index = u32be(blocks, j), bw = u32be(blocks, j + 8), bh = u32be(blocks, j + 12);
    const notEmpty = u32be(blocks, j + 16);
    if (notEmpty) {
      const clen = u32le(blocks, j + 24);
      let raw = null;
      try {
        raw = await inflate(blocks.subarray(j + 28, j + 28 + clen));
      } catch (e) {
        raw = null;
      }
      const x = (index % gw) * 256, y = Math.floor(index / gw) * 256;
      if (raw && raw.length && x + bw <= W && y + bh <= H && pasteBlock(img, W, x, y, bw, bh, raw)) filled++;
    }
    if (chunkLen <= 0) break;
    i += chunkLen;
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    out.set(img.subarray(row * W * 4, (row * W + width) * 4), row * width * 4);
  }
  return { width, height, data: out, filled };
}

/** Most complete pixel layer in a .layer file, or null. */
export async function decodeLayer(layerBytes) {
  const db = c2fDatabase(layerBytes);
  let best = null;
  for (const values of iterRows(db)) {
    for (let k = 0; k < values.length; k++) {
      if (!isOffscreenAttr(values[k])) continue;
      const blocks = values.slice(k + 1).find((v) => v instanceof Uint8Array && v.length > 8
        && u32be(v, 4) === BLOCK_BEGIN.length);
      if (!blocks) continue;
      let image;
      try {
        image = await decodeOffscreen(values[k], blocks);
      } catch (e) {
        continue;
      }
      const better = !best || image.filled > best.filled
        || (image.filled === best.filled && image.width * image.height > best.width * best.height);
      if (image.filled && better) best = image;
    }
  }
  return best;
}

/**
 * Decode a MaterialFile.FileData blob.
 * Returns {image: {width, height, data}, source: 'layer'}, or
 * {png: Uint8Array, source: 'thumbnail'} when only the preview is readable, or null.
 */
export async function decodeMaterial(blob) {
  let files;
  try {
    files = parseTar(blob);
  } catch (e) {
    return null;
  }
  for (const f of files) {
    if (!f.name.endsWith('.layer')) continue;
    try {
      const image = await decodeLayer(f.data);
      if (image) return { image, source: 'layer' };
    } catch (e) {
      // fall through to the thumbnail
    }
  }
  const thumb = files.find((f) => f.name.endsWith('thumbnail.png'));
  return thumb ? { png: thumb.data, source: 'thumbnail' } : null;
}
