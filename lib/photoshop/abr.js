// Photoshop brush files (.abr). DOM-free; see docs/abr-format.md for the layout.
//
//   v1, v2 (Photoshop ≤ 6):   a list of computed / sampled brush records, no dynamics.
//   v6, v7, v9, v10 (7 → CC): '8BIM' sections: 'samp' tip images, 'patt' patterns,
//                             'desc' the brush presets as an action descriptor, and
//                             'phry' the Brushes panel folders.

import { brushFromPreset, groupPaths, plainBrush, sampleTip } from './brush.js';
import { readVersionedDescriptor } from './descriptor.js';
import { readPatterns } from './pattern.js';
import { Cursor, readRows, toEightBit } from './stream.js';

const stemOf = (fileName) => fileName.split('/').pop().replace(/\.abr$/i, '') || 'brush';

/** Tip pixels: `h` rows of `w` samples at `depth` bits, raw or RLE. 255 = full paint. */
function readMask(cur, w, h, depth, compression) {
  if (w <= 0 || h <= 0 || w * h > 1 << 26) throw new Error(`bad tip size ${w}x${h}`);
  return { width: w, height: h, data: toEightBit(readRows(cur, h, w * (depth >> 3), compression), depth) };
}

function readLegacy(cur, version, stem) {
  const count = cur.u16();
  const brushes = [], warnings = [];
  for (let i = 0; i < count && cur.left >= 6; i++) {
    const type = cur.u16();
    const rec = cur.sub(Math.min(cur.u32(), cur.left));
    const fallback = `${stem} ${i + 1}`;
    try {
      rec.u32(); // misc
      const spacing = rec.u16() / 100;
      if (type === 1) {
        // Computed: diameter, roundness, angle, hardness (v2 may name it first).
        const name = version === 2 && rec.left > 8 ? rec.unicode() : '';
        const size = rec.u16(), roundness = rec.u16() / 100, angle = rec.i16(), hardness = rec.u16() / 100;
        brushes.push(plainBrush(name || fallback, {
          ...sampleTip(null, spacing), kind: 'computed', size, angle, roundness, hardness,
        }));
      } else if (type === 2) {
        const name = version === 2 ? rec.unicode() : '';
        rec.skip(1 + 8); // antialiasing, short bounds
        const top = rec.i32(), left = rec.i32(), bottom = rec.i32(), right = rec.i32();
        const depth = rec.u16(), compression = rec.u8();
        brushes.push(plainBrush(name || fallback, sampleTip(readMask(rec, right - left, bottom - top, depth, compression), spacing)));
      } else {
        warnings.push(`brush ${i + 1}: unknown type ${type}, skipped`);
      }
    } catch (e) {
      warnings.push(`brush ${i + 1}: ${e.message}`);
    }
  }
  return { version: `${version}`, brushes, warnings };
}

function readSamples(sec, subversion, samples, warnings) {
  while (sec.left >= 4) {
    const rec = sec.sub(Math.min((sec.u32() + 3) & ~3, sec.left)); // entries are padded to 4 bytes
    let id = '?';
    try {
      id = rec.pascal();
      rec.skip(subversion === 1 ? 10 : 264); // short bounds + unknown (v1); unknown (v2)
      const top = rec.i32(), left = rec.i32(), bottom = rec.i32(), right = rec.i32();
      const depth = rec.u16(), compression = rec.u8();
      samples.set(id, readMask(rec, right - left, bottom - top, depth, compression));
    } catch (e) {
      warnings.push(`tip image ${id}: ${e.message}`);
    }
  }
}

function readSections(cur, version, stem) {
  const subversion = cur.u16();
  if (subversion !== 1 && subversion !== 2) throw new Error(`unsupported .abr version ${version}.${subversion}`);
  const samples = new Map();
  let patterns = new Map(), presets = null, hierarchy = null;
  const warnings = [];
  while (cur.left >= 12) {
    const at = cur.offset;
    const sig = cur.sig(), type = cur.sig(), length = cur.u32();
    if (sig !== '8BIM') throw new Error(`damaged file: no section marker at byte ${at}`);
    const sec = cur.sub(Math.min(length, cur.left));
    try {
      if (type === 'samp') readSamples(sec, subversion, samples, warnings);
      else if (type === 'patt') {
        const read = readPatterns(sec);
        patterns = read.patterns;
        warnings.push(...read.warnings);
      }
      else if (type === 'desc') presets = readVersionedDescriptor(sec).Brsh || [];
      else if (type === 'phry') hierarchy = readVersionedDescriptor(sec).hierarchy || [];
      else warnings.push(`unknown '${type}' section skipped`);
    } catch (e) {
      if (type === 'desc') throw new Error(`brush settings: ${e.message}`);
      warnings.push(`'${type}' section: ${e.message}`);
    }
    cur.skip(Math.min((4 - (length % 4)) % 4, cur.left));
  }

  const brushes = (presets || []).map((p, i) => brushFromPreset(p, { samples, patterns, fallbackName: `${stem} ${i + 1}` }));
  if (hierarchy && hierarchy.length) {
    const paths = groupPaths(hierarchy, brushes.length);
    if (paths) paths.forEach((path, i) => { brushes[i].group = path; });
    else warnings.push("the Brushes panel folders don't match the presets; folders skipped");
  }
  // Tips no preset uses (or every tip, in files without presets) become plain brushes, as in
  // Krita's own .abr import.
  const used = new Set(brushes.flatMap((b) => [b.tip.sampleId, b.dual && b.dual.tip.sampleId]));
  let n = 0;
  for (const [id, mask] of samples) {
    if (!used.has(id)) brushes.push(plainBrush(`${stem} tip ${++n}`, sampleTip(mask, 0.25)));
  }
  return { version: `${version}.${subversion}`, brushes, warnings };
}

/** Parse one .abr. Returns {version, brushes, warnings}. */
export function readAbr(bytes, fileName = 'brushes.abr') {
  const cur = new Cursor(bytes);
  if (cur.left < 4) throw new Error('not a Photoshop brush file (too short)');
  const version = cur.u16();
  const stem = stemOf(fileName);
  if (version === 1 || version === 2) return readLegacy(cur, version, stem);
  if ([6, 7, 9, 10].includes(version)) return readSections(cur, version, stem);
  throw new Error(`not a Photoshop brush file (version ${version})`);
}

/**
 * Several dropped files: .abr, or .zip packs holding them.
 * files: [{name, data: Uint8Array}]. Returns {brushes: [{..., file}], files: [{name, version, count, warnings}], errors}.
 */
export async function readAbrFiles(JSZip, files, onProgress = () => {}) {
  const queue = [];
  const errors = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      let zip;
      try { zip = await JSZip.loadAsync(f.data); } catch (e) { errors.push(`${f.name}: not a ZIP (${e.message})`); continue; }
      const inner = Object.values(zip.files).filter((e) => !e.dir && /\.abr$/i.test(e.name) && !/(^|\/)(__MACOSX\/|\._)/.test(e.name));
      if (!inner.length) errors.push(`${f.name}: no .abr files inside`);
      for (const e of inner) queue.push({ name: e.name.split('/').pop(), load: () => e.async('uint8array') });
      continue;
    }
    queue.push({ name: f.name, load: async () => f.data });
  }
  const brushes = [], read = [];
  for (const [i, q] of queue.entries()) {
    onProgress(i + 1, queue.length, q.name);
    try {
      const abr = readAbr(await q.load(), q.name);
      read.push({ name: q.name, version: abr.version, count: abr.brushes.length, warnings: abr.warnings });
      for (const b of abr.brushes) brushes.push({ ...b, file: q.name });
    } catch (e) {
      errors.push(`${q.name}: ${e.message}`);
    }
  }
  return { brushes, files: read, errors };
}
