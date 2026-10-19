// Apple binary property lists (bplist00) and NSKeyedArchiver archives.
// Parser from the Procreate→CSP tool, writer from the CSP→Procreate tool.

export class UID {
  constructor(v) { this.uid = v; }
  toString() { return `UID(${this.uid})`; }
}

function readUInt(u8, o, n) {
  let r = 0n;
  for (let i = 0; i < n; i++) r = (r << 8n) | BigInt(u8[o + i]);
  return Number(r);
}

/** Parse a bplist00 buffer. Returns {top, raw, nObj}; containers are resolved into JS values. */
export function parseBplist(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(...u8.subarray(0, 6));
  if (magic !== 'bplist') throw new Error(`Not a binary plist (magic: ${magic})`);
  const T = u8.length - 32;
  const offSize = u8[T + 6], refSize = u8[T + 7];
  const nObj = readUInt(u8, T + 8, 8), topIdx = readUInt(u8, T + 16, 8), otOff = readUInt(u8, T + 24, 8);
  const offsets = [];
  for (let i = 0; i < nObj; i++) offsets.push(readUInt(u8, otOff + i * offSize, offSize));

  function parseObj(idx) {
    if (idx >= nObj) return null;
    let p = offsets[idx];
    const marker = u8[p], hi = marker >> 4, lo = marker & 0x0F;
    p++;
    const size = () => {
      if (lo !== 0x0F) return lo;
      const n = 1 << (u8[p] & 0x0F);
      const v = readUInt(u8, p + 1, n);
      p += 1 + n;
      return v;
    };
    switch (hi) {
      case 0x0: return lo === 8 ? false : lo === 9 ? true : null;
      case 0x1: {
        const n = 1 << lo;
        if (n === 8) return Number(dv.getBigInt64(p, false)); // only 8-byte ints are signed
        return readUInt(u8, p, n);
      }
      case 0x2: return lo === 2 ? dv.getFloat32(p, false) : lo === 3 ? dv.getFloat64(p, false) : 0;
      case 0x3: return new Date(978307200000 + dv.getFloat64(p, false) * 1000);
      case 0x4: { const n = size(); return u8.slice(p, p + n); }
      case 0x5: { const n = size(); return String.fromCharCode(...u8.subarray(p, p + n)); }
      case 0x6: { const n = size(); let s = ''; for (let j = 0; j < n; j++) s += String.fromCharCode(dv.getUint16(p + j * 2, false)); return s; }
      case 0x8: return new UID(readUInt(u8, p, lo + 1));
      case 0xA: case 0xC: { const n = size(); const r = []; for (let j = 0; j < n; j++) r.push(readUInt(u8, p + j * refSize, refSize)); return { _t: 'arr', r }; }
      case 0xD: {
        const n = size(), k = [], v = [];
        for (let j = 0; j < n; j++) k.push(readUInt(u8, p + j * refSize, refSize));
        for (let j = 0; j < n; j++) v.push(readUInt(u8, p + (n + j) * refSize, refSize));
        return { _t: 'dict', k, v };
      }
      default: return null;
    }
  }

  const raw = [];
  for (let i = 0; i < nObj; i++) raw.push(parseObj(i));
  const cache = new Map();
  function resolve(i, depth) {
    if (depth > 80) return '<depth>';
    if (cache.has(i)) return cache.get(i);
    const o = raw[i];
    if (o == null || typeof o !== 'object' || o instanceof Date || o instanceof Uint8Array || o instanceof UID) {
      cache.set(i, o ?? null);
      return o ?? null;
    }
    if (o._t === 'arr') { const a = []; cache.set(i, a); for (const r of o.r) a.push(resolve(r, depth + 1)); return a; }
    const m = {};
    cache.set(i, m);
    for (let j = 0; j < o.k.length; j++) m[String(resolve(o.k[j], depth + 1))] = resolve(o.v[j], depth + 1);
    return m;
  }
  return { top: resolve(topIdx, 0), raw, nObj };
}

/** Resolve an NSKeyedArchiver plist into plain objects (NSDictionary/NSArray/NSData unwrapped). */
export function resolveNSKA(pl) {
  if (!pl || !pl.$objects || !pl.$top) return pl;
  const ob = pl.$objects, rootU = pl.$top.root;
  if (!(rootU instanceof UID)) return pl;
  const cache = new Map(), visiting = new Set();
  function r(v, d) {
    if (d > 60) return '<depth>';
    if (v == null || v === '$null') return null;
    if (v instanceof UID) {
      if (visiting.has(v.uid)) return '<circ>';
      if (cache.has(v.uid)) return cache.get(v.uid);
      visiting.add(v.uid);
      const x = r(ob[v.uid], d + 1);
      cache.set(v.uid, x);
      visiting.delete(v.uid);
      return x;
    }
    if (Array.isArray(v)) return v.map((x) => r(x, d + 1));
    if (v instanceof Uint8Array || v instanceof Date) return v;
    if (typeof v === 'object') {
      if (v['NS.keys'] && v['NS.objects']) {
        const ks = r(v['NS.keys'], d + 1) || [], vs = r(v['NS.objects'], d + 1) || [], m = {};
        for (let i = 0; i < ks.length; i++) m[String(ks[i])] = vs[i] !== undefined ? vs[i] : null;
        return m;
      }
      if (v['NS.objects']) return r(v['NS.objects'], d + 1);
      if (v['NS.data'] !== undefined) return r(v['NS.data'], d + 1);
      const m = {};
      for (const k in v) if (k !== '$class') m[k] = r(v[k], d + 1);
      return m;
    }
    return v;
  }
  return r(rootU, 0);
}

/** Serialise a JS value tree (objects, arrays, strings, numbers, booleans, Uint8Array, UID) as bplist00. */
export function writeBplist(rootValue) {
  const objs = [], seen = new Map();
  function intern(val) {
    const dedupe = (key, make) => {
      if (seen.has(key)) return seen.get(key);
      const i = objs.length; objs.push(make()); seen.set(key, i); return i;
    };
    if (val == null) return dedupe('N', () => ({ t: 0 }));
    if (typeof val === 'boolean') return dedupe(`B${val}`, () => ({ t: 1, v: val }));
    if (val instanceof UID) { objs.push({ t: 8, v: val.uid }); return objs.length - 1; }
    if (val instanceof Uint8Array) { objs.push({ t: 4, v: val }); return objs.length - 1; }
    if (typeof val === 'number') {
      return Number.isInteger(val) ? dedupe(`I${val}`, () => ({ t: 2, v: val })) : dedupe(`F${val}`, () => ({ t: 3, v: val }));
    }
    if (typeof val === 'string') return dedupe(`S${val}`, () => ({ t: 5, v: val }));
    if (Array.isArray(val)) {
      const i = objs.length; objs.push(null);
      objs[i] = { t: 10, r: val.map(intern) };
      return i;
    }
    if (typeof val === 'object') {
      const i = objs.length; objs.push(null);
      const keys = Object.keys(val);
      objs[i] = { t: 13, k: keys.map((k) => intern(k)), v: keys.map((k) => intern(val[k])) };
      return i;
    }
    return intern(null);
  }
  const topIdx = intern(rootValue);
  const N = objs.length;
  const refSize = N < 256 ? 1 : N < 65536 ? 2 : 4;
  const beInt = (v, n) => { const a = []; for (let i = n - 1; i >= 0; i--) a.push(Number((BigInt(v) >> BigInt(i * 8)) & 0xFFn)); return a; };
  const lenHeader = (nib, count) => {
    if (count < 15) return [(nib << 4) | count];
    if (count < 256) return [(nib << 4) | 0x0F, 0x10, count];
    if (count < 65536) return [(nib << 4) | 0x0F, 0x11, ...beInt(count, 2)];
    return [(nib << 4) | 0x0F, 0x12, ...beInt(count, 4)];
  };
  const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); return [...b]; };
  function encode(o) {
    switch (o.t) {
      case 0: return [0x00];
      case 1: return [o.v ? 0x09 : 0x08];
      case 2: {
        const v = o.v; // 1/2/4-byte ints are unsigned in bplist; negatives need 8 bytes
        if (v >= 0 && v < 256) return [0x10, v];
        if (v >= 0 && v < 65536) return [0x11, ...beInt(v, 2)];
        if (v >= 0 && v < 4294967296) return [0x12, ...beInt(v, 4)];
        return [0x13, ...beInt(BigInt.asUintN(64, BigInt(v)), 8)];
      }
      case 3: return [0x23, ...f64(o.v)];
      case 4: return [...lenHeader(4, o.v.length), ...o.v];
      case 5: {
        if (/^[\x00-\x7f]*$/.test(o.v)) return [...lenHeader(5, o.v.length), ...Array.from(o.v, (c) => c.charCodeAt(0))];
        const units = [];
        for (let i = 0; i < o.v.length; i++) { const c = o.v.charCodeAt(i); units.push(c >> 8, c & 0xFF); }
        return [...lenHeader(6, o.v.length), ...units];
      }
      case 8: { const n = o.v < 256 ? 1 : o.v < 65536 ? 2 : 4; return [0x80 | (n - 1), ...beInt(o.v, n)]; }
      case 10: return [...lenHeader(0xA, o.r.length), ...o.r.flatMap((r) => beInt(r, refSize))];
      case 13: return [...lenHeader(0xD, o.k.length), ...o.k.flatMap((r) => beInt(r, refSize)), ...o.v.flatMap((r) => beInt(r, refSize))];
      default: return [0x00];
    }
  }
  const encoded = objs.map(encode);
  const offsets = [];
  let pos = 8;
  for (const e of encoded) { offsets.push(pos); pos += e.length; }
  const otOff = pos;
  const offSize = otOff < 256 ? 1 : otOff < 65536 ? 2 : 4;
  const out = new Uint8Array(otOff + N * offSize + 32);
  out.set([0x62, 0x70, 0x6C, 0x69, 0x73, 0x74, 0x30, 0x30], 0); // "bplist00"
  let w = 8;
  for (const e of encoded) { out.set(e, w); w += e.length; }
  for (const off of offsets) { out.set(beInt(off, offSize), w); w += offSize; }
  const trailer = new Uint8Array(32);
  trailer[6] = offSize;
  trailer[7] = refSize;
  trailer.set(beInt(N, 8), 8);
  trailer.set(beInt(topIdx, 8), 16);
  trailer.set(beInt(otOff, 8), 24);
  out.set(trailer, w);
  return out;
}

/** NSKeyedArchiver archive with a single SilicaBrush root object (Procreate Brush.archive). */
export function buildBrushArchive(params) {
  const brush = { $class: new UID(2), ...params };
  return writeBplist({
    $archiver: 'NSKeyedArchiver',
    $version: 100000,
    $top: { root: new UID(1) },
    $objects: ['$null', brush, { $classname: 'SilicaBrush', $classes: ['SilicaBrush', 'NSObject'] }],
  });
}
