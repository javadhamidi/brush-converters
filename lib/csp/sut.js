// Read brushes out of a Clip Studio Paint .sut file (a SQLite database).
// Port of python/sut2krita/sut_reader.py.
//
//   Node          one row per sub tool; NodeVariantID points at its settings
//   Variant       the brush parameters, one column per setting
//   MaterialFile  embedded images (brush tips, paper textures)
//
// Image-valued Variant columns (BrushPatternImageArray, TextureImage,
// DualPatternImageArray) list references to MaterialFile rows by OriginalPath.

import { decodeUtf16, u8 } from '../bytes.js';
import { decodeMaterial } from './c2f.js';

export const IMAGE_COLUMNS = ['BrushPatternImageArray', 'TextureImage', 'DualPatternImageArray'];

/** [{path, name}] from an image-array column. */
export function parseImageRefs(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 8) return [];
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const refs = [];
  try {
    const count = dv.getUint32(4, false);
    let i = dv.getUint32(0, false);
    for (let k = 0; k < count; k++) {
      const itemLen = dv.getUint32(i, false), pathLen = dv.getUint32(i + 4, false);
      const path = decodeUtf16(blob.subarray(i + 8, i + 8 + pathLen), true);
      const rest = blob.subarray(i + 8 + pathLen, i + itemLen);
      let name = '';
      if (rest.length >= 8) {
        const nameLen = new DataView(rest.buffer, rest.byteOffset, rest.byteLength).getUint32(4, false);
        name = decodeUtf16(rest.subarray(8, 8 + nameLen), true);
      }
      refs.push({ path, name });
      if (itemLen <= 0) break;
      i += itemLen;
    }
  } catch (e) {
    // truncated blob: keep what was read
  }
  return refs;
}

function rows(db, sql, params) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => {
    const o = {};
    columns.forEach((c, i) => { o[c] = v[i] instanceof Uint8Array || (v[i] && v[i].buffer) ? u8(v[i]) : v[i]; });
    return o;
  });
}

function columnsOf(db, table) {
  return rows(db, `PRAGMA table_info(${table})`).map((r) => r.name);
}

const basename = (p) => p.split(/[\\/:]/).pop();

/**
 * Read every brush in a .sut.
 * @param SQL   initialised sql.js module
 * @param bytes file contents
 * @param opts.decodePng  async (pngBytes) => {width, height, data} for thumbnail-only materials
 * @param opts.onProgress (message) => void
 */
export async function readSut(SQL, bytes, opts = {}) {
  const db = new SQL.Database(bytes);
  try {
    const cache = new Map();
    const variantCols = columnsOf(db, 'Variant');
    const materialCols = columnsOf(db, 'MaterialFile');

    async function material(path, name, fileData) {
      const key = path ?? `#${name}`;
      if (!cache.has(key)) {
        let blob = fileData;
        if (blob === undefined) {
          const r = rows(db, 'SELECT FileData FROM MaterialFile WHERE OriginalPath = ?', [path])[0];
          blob = r && r.FileData;
        }
        let decoded = blob ? await decodeMaterial(blob) : null;
        if (decoded && decoded.png) {
          let image = null;
          if (opts.decodePng) {
            try { image = await opts.decodePng(decoded.png); } catch (e) { image = null; }
          }
          decoded = image ? { image, source: 'thumbnail', png: decoded.png } : null;
        }
        cache.set(key, decoded);
      }
      const d = cache.get(key);
      return { name: name || basename(path || 'material'), path, image: d ? d.image : null, source: d ? d.source : null };
    }

    async function materialsFor(blob, warnings, role) {
      const out = [];
      for (const { path, name } of parseImageRefs(blob)) {
        const mat = await material(path, name);
        if (!mat.image) {
          warnings.push(`${role} image '${mat.name}' could not be decoded`);
          continue;
        }
        if (mat.source === 'thumbnail') warnings.push(`${role} image '${mat.name}' only available as a low-res thumbnail`);
        out.push(mat);
      }
      return out;
    }

    const nodes = rows(db, 'SELECT NodeName, NodeVariantID AS NodeVariantID FROM Node WHERE NodeVariantID IS NOT NULL AND NodeVariantID != 0');
    const fileStem = (opts.fileName || 'brush').replace(/\.[^.]+$/, '');
    const brushes = [];
    for (const node of nodes) {
      const variant = rows(db, 'SELECT * FROM Variant WHERE VariantID = ?', [node.NodeVariantID])[0];
      if (!variant) continue;
      const brush = {
        name: node.NodeName || fileStem,
        sourceFile: opts.fileName || '',
        params: variant,
        tips: [],
        texture: null,
        dualTips: [],
        warnings: [],
      };
      opts.onProgress?.(`decoding images for "${brush.name}"`);
      const p = variant;
      if (p.BrushUsePatternImage) brush.tips = await materialsFor(p.BrushPatternImageArray, brush.warnings, 'tip');
      if (p.TextureDensity) {
        const textures = await materialsFor(p.TextureImage, brush.warnings, 'texture');
        brush.texture = textures[0] || null;
      }
      if (p.UseDualBrush && p.DualUsePatternImage) {
        brush.dualTips = await materialsFor(p.DualPatternImageArray, brush.warnings, 'dual brush tip');
      }
      // Minimal .sut files (e.g. written by older converters) have no image references:
      // fall back to the first material as the tip.
      if (!variantCols.includes('BrushPatternImageArray') && !materialCols.includes('OriginalPath')) {
        const first = rows(db, 'SELECT FileData FROM MaterialFile LIMIT 1')[0];
        if (first && first.FileData) {
          const mat = await material(null, 'tip', first.FileData);
          if (mat.image) {
            brush.tips = [mat];
            brush.warnings.push('no image references in this .sut; using its first material as the tip');
          }
        }
      }
      brushes.push(brush);
    }
    return brushes;
  } finally {
    db.close();
  }
}
