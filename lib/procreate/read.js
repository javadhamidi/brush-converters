// Read Procreate .brush / .brushset files (ZIPs holding Brush.archive + Shape/Grain images).
// DOM-free: JSZip is passed in; images are returned as PNG/JPEG bytes.

import { parseBplist, resolveNSKA } from '../bplist.js';
import { settingsFromArchive } from './settings.js';

/** Resolved SilicaBrush object -> flat {key: number | boolean | string | curve}. */
export function flattenBrush(root) {
  const flat = {};
  (function walk(o) {
    if (!o || typeof o !== 'object' || o instanceof Uint8Array || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      if (k[0] === '$' || k.startsWith('NS.')) continue;
      const v = o[k];
      if (v == null) continue;
      if (['number', 'boolean', 'string'].includes(typeof v)) flat[k] = v;
      else if (typeof v === 'object' && Array.isArray(v.points)) flat[k] = v; // pressure curves
      else if (typeof v === 'object' && !(v instanceof Uint8Array) && !Array.isArray(v) && !('NS.time' in v)) walk(v);
    }
  })(root);
  return flat;
}

/** Parse one Brush.archive (bytes) -> flat key dictionary. */
export function readArchive(bytes) {
  const pl = parseBplist(bytes);
  if (!pl.top || !pl.top.$objects) throw new Error('Brush.archive is not an NSKeyedArchive');
  return flattenBrush(resolveNSKA(pl.top));
}

const stem = (name) => name.split('/').pop().replace(/\.(brush|brushset|zip)$/i, '');

/**
 * Read a .brush or .brushset (or a .zip of either's contents).
 * Returns [{name, path, raw, settings, shape, grain}] where shape/grain are image bytes or null.
 * Brushes keep a "Reset/" copy of their original settings; that copy is ignored.
 */
export async function readProcreate(JSZip, bytes, fileName = 'brush.brush') {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((e) => !e.dir && !e.name.includes('__MACOSX'));
  const byLower = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  let archives = entries.filter((e) => /(^|\/)Brush\.archive$/i.test(e.name) && !/(^|\/)Reset\//i.test(e.name));
  if (!archives.length) archives = entries.filter((e) => /(^|\/)Brush\.archive$/i.test(e.name)).slice(0, 1);
  if (!archives.length) throw new Error(`${fileName}: no Brush.archive inside — not a Procreate brush`);

  // A .brushset lists its brush folders in brushset.plist; keep that order.
  const listing = byLower.get('brushset.plist');
  let setName = null;
  if (listing) {
    try {
      const pl = parseBplist(await listing.async('uint8array')).top;
      setName = pl && typeof pl.name === 'string' ? pl.name : null;
      const order = Array.isArray(pl && pl.brushes) ? pl.brushes.map(String) : [];
      const rank = (e) => { const i = order.indexOf(e.name.split('/')[0]); return i < 0 ? order.length : i; };
      archives.sort((a, b) => rank(a) - rank(b));
    } catch { /* order is cosmetic */ }
  }

  const out = [];
  for (const entry of archives) {
    const prefix = entry.name.slice(0, entry.name.length - 'Brush.archive'.length);
    const image = async (base) => {
      for (const ext of ['png', 'jpg', 'jpeg']) {
        const e = byLower.get(`${prefix}${base}.${ext}`.toLowerCase());
        if (e) return e.async('uint8array');
      }
      return null;
    };
    const raw = readArchive(await entry.async('uint8array'));
    const fallback = archives.length > 1 ? (prefix.replace(/\/$/, '').split('/').pop() || stem(fileName)) : stem(fileName);
    out.push({
      name: String(raw.name || '').trim() || fallback,
      path: entry.name,
      raw,
      settings: settingsFromArchive(raw, fallback),
      shape: await image('Shape'),
      grain: await image('Grain'),
    });
  }
  out.setName = setName;
  return out;
}

const luma = (d, i) => (d[i] * 19595 + d[i + 1] * 38470 + d[i + 2] * 7471 + 0x8000) >> 16;

/** Shape.png (RGBA) -> gray mask, 255 = paint. Procreate paints with white; transparency hides. */
export function shapeMask(img, inverted = false) {
  const n = img.width * img.height, d = img.data, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = (luma(d, i * 4) * d[i * 4 + 3] + 127) / 255 | 0;
    out[i] = inverted ? 255 - v : v;
  }
  return { width: img.width, height: img.height, data: out };
}

/** Grain.png (RGBA) -> gray, 255 = paint shows through (white), same convention as Procreate. */
export function grainGray(img, inverted = false) {
  return shapeMask(img, inverted);
}

/** Procreate's built-in shapes are referenced by name only; approximate the common ones. */
export function bundledShapeGuess(name) {
  if (!name) return null;
  if (/oval/i.test(name)) return { hardness: 1, ratio: 0.5 };
  if (/soft|air/i.test(name)) return { hardness: 0.3, ratio: 1 };
  if (/hard|point|round|circle|disc/i.test(name)) return { hardness: 1, ratio: 1 };
  return null;
}

/**
 * Several dropped files: .brush, .brushset, or .zip packs holding either.
 * files: [{name, data: Uint8Array}]. Returns {brushes: [{..., file}], errors: [string]}.
 */
export async function readProcreateFiles(JSZip, files, onProgress = () => {}) {
  const queue = [];
  const errors = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      let zip;
      try { zip = await JSZip.loadAsync(f.data); } catch (e) { errors.push(`${f.name}: not a ZIP (${e.message})`); continue; }
      const inner = Object.values(zip.files).filter((e) => !e.dir && /\.(brush|brushset)$/i.test(e.name) && !e.name.includes('__MACOSX'));
      if (inner.length) {
        for (const e of inner) queue.push({ name: e.name.split('/').pop(), load: () => e.async('uint8array') });
        continue;
      }
    }
    queue.push({ name: f.name, load: async () => f.data });
  }
  const brushes = [];
  for (const [i, q] of queue.entries()) {
    onProgress(i + 1, queue.length, q.name);
    try {
      for (const b of await readProcreate(JSZip, await q.load(), q.name)) brushes.push({ ...b, file: q.name });
    } catch (e) {
      errors.push(`${q.name}: ${e.message}`);
    }
  }
  return { brushes, errors };
}
