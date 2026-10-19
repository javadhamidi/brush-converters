// Read Krita presets (.kpp), bundles (.bundle) and their brush tips and patterns. DOM-free:
// JSZip and image decoding are passed in.
//
//   .kpp     PNG thumbnail; the preset XML sits in a "preset" tEXt / zTXt / iTXt chunk
//   preset   <Preset paintopid="paintbrush" name="..."> <param name="..."><![CDATA[...]]></param> ...
//   sensors  "<params id="pressure"><curve>x,y;x,y;</curve></params>", or a "sensorslist" of
//            <ChildSensor>s; "<Opt>UseSameCurve" + "<Opt>commonCurve" overrides each sensor's curve
//   tips     brush_definition XML: auto_brush (generated), png_brush / svg_brush (images),
//            gbr_brush (.gbr / .gih GIMP brushes); paint = dark ink x alpha
//   patterns embedded in Texture/Pattern/Pattern (base64 PNG), or a file in patterns/

import { inflate } from '../inflate.js';
import { flattenGray } from '../pixels.js';

const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return s; };
const utf8 = (b) => new TextDecoder().decode(b);
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/* ── .kpp ── */

/** All text chunks of a PNG, inflating zTXt and compressed iTXt. */
export async function pngTexts(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('not a PNG file');
  const out = {};
  for (let o = 8; o + 8 <= bytes.length;) {
    const len = be32(bytes, o), type = latin1(bytes.subarray(o + 4, o + 8));
    const data = bytes.subarray(o + 8, o + 8 + len);
    o += 12 + len;
    if (type === 'IEND') break;
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue;
    const z = data.indexOf(0);
    const key = latin1(data.subarray(0, z));
    if (type === 'tEXt') out[key] = utf8(data.subarray(z + 1));
    else if (type === 'zTXt') out[key] = utf8(await inflate(data.subarray(z + 2)));
    else {
      const compressed = data[z + 1];
      let p = data.indexOf(0, z + 3); // language tag
      p = data.indexOf(0, p + 1); // translated keyword
      const text = data.subarray(p + 1);
      out[key] = utf8(compressed ? await inflate(text) : text);
    }
  }
  return out;
}

/** .kpp bytes -> preset XML text. */
export async function parseKpp(bytes) {
  const texts = await pngTexts(bytes);
  if (!texts.preset) throw new Error('no preset data in this .kpp');
  return texts.preset;
}

const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return map[e.toLowerCase()];
});

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = unescapeXml(m[3] ?? m[4]);
  return out;
}

/** Preset XML -> {engine, name, params}. Values stay strings, as Krita stores them. */
export function parsePresetXml(xml) {
  const head = /<Preset\b[^>]*>/.exec(xml);
  if (!head) throw new Error('preset XML has no <Preset> element');
  const a = attrs(head[0]);
  const params = {};
  for (const m of xml.matchAll(/<param\b([^>]*?)(?:\/>|>([\s\S]*?)<\/param>)/g)) {
    const pa = attrs(m[1]);
    if (!pa.name) continue;
    const body = m[2] ?? '';
    const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(body);
    params[pa.name] = cdata ? cdata[1] : unescapeXml(body);
  }
  return { engine: a.paintopid || params.paintop || 'unknown', name: a.name || 'Preset', params };
}

/* ── Sensors and curves ── */

export function parseCurve(text) {
  if (!text) return null;
  const pts = String(text).split(';').map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  return pts.length >= 2 ? pts.sort((a, b) => a[0] - b[0]) : null;
}

export function curveAt(points, x) {
  if (!points || !points.length) return x;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

/** Sensor XML -> [{id, curve, attrs}]; curve null means Krita's default (linear). */
export function parseSensors(xml) {
  if (!xml) return [];
  const out = [];
  const one = (tagAttrs, body) => {
    const a = attrs(tagAttrs);
    const c = /<curve>([\s\S]*?)<\/curve>/.exec(body || '');
    out.push({ id: a.id, curve: c ? parseCurve(c[1]) : null, attrs: a });
  };
  const root = /<params\b([^>]*?)(\/>|>([\s\S]*)<\/params>)/.exec(xml);
  if (!root) return [];
  const rootAttrs = attrs(root[1]);
  if (rootAttrs.id === 'sensorslist') {
    for (const m of (root[3] || '').matchAll(/<ChildSensor\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ChildSensor>)/g)) one(m[1], m[2]);
  } else one(root[1], root[3]);
  return out.filter((s) => s.id);
}

const ALWAYS_ON = ['Opacity', 'Flow'];
const LINEAR = [[0, 0], [1, 1]];

/** Sensors driving option `opt` (e.g. 'Size'), or null when the option is off. */
export function optionSensors(params, opt, prefix = '') {
  const get = (k) => params[`${prefix}${k}`];
  const pressure = get(`Pressure${opt}`);
  // Krita 4+: Opacity/Flow have no Pressure<Opt> switch, and UseCurve is what turns them on.
  const useCurveIsSwitch = ALWAYS_ON.includes(opt) && pressure == null;
  const enabled = useCurveIsSwitch ? get(`${opt}UseCurve`) === 'true' : pressure === 'true';
  if (!enabled) return null;
  const sensors = parseSensors(get(`${opt}Sensor`));
  const common = get(`${opt}UseSameCurve`) !== 'false' ? parseCurve(get(`${opt}commonCurve`)) : null;
  const useCurve = useCurveIsSwitch || get(`${opt}UseCurve`) !== 'false';
  for (const s of sensors) {
    if (common) s.curve = common;
    if (!useCurve || !s.curve) s.curve = LINEAR;
  }
  return sensors;
}

/* ── Brush tips ── */

/** brush_definition XML -> {type, filename, scale, spacing, angle (radians), autoSpacing, mask}. */
export function parseBrushDefinition(xml) {
  if (!xml) return null;
  const brush = /<Brush\b([^>]*?)\/?>/.exec(xml);
  if (!brush) return null;
  const a = attrs(brush[1]);
  const g = /<MaskGenerator\b([^>]*?)\/?>/.exec(xml);
  const n = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    type: a.type || 'auto_brush',
    filename: a.filename || null,
    scale: n(a.scale, 1),
    spacing: n(a.spacing, 0.1),
    angle: n(a.angle, 0),
    autoSpacing: a.useAutoSpacing === '1' || a.useAutoSpacing === 'true',
    autoSpacingCoeff: n(a.autoSpacingCoeff, 1),
    mask: g ? (() => {
      const m = attrs(g[1]);
      return {
        type: m.type || 'circle', id: m.id || 'default', diameter: n(m.diameter, 10), ratio: n(m.ratio, 1),
        hfade: n(m.hfade, 1), vfade: n(m.vfade, 1), spikes: n(m.spikes, 2), softnessCurve: parseCurve(m.softness_curve),
      };
    })() : null,
  };
}

/** Render a Krita auto_brush mask generator into a square gray mask (255 = paint). */
export function autoMask(gen, side = 256) {
  const data = new Uint8Array(side * side);
  const r = side / 2;
  const ratio = Math.min(Math.max(gen.ratio || 1, 0.01), 1);
  const fade = Math.min(Math.max(gen.hfade ?? 1, 0), 1);
  const peak = gen.softnessCurve ? Math.max(...gen.softnessCurve.map((p) => p[1]), 1e-6) : 1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = (x + 0.5 - r) / r, dy = (y + 0.5 - r) / (r * ratio);
      const d = gen.type === 'rect' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
      let v;
      if (d >= 1) v = 0;
      else if (gen.id === 'gauss') {
        const sigma = 0.12 + 0.4 * fade;
        v = Math.exp(-(d * d) / (2 * sigma * sigma)) * (1 - d ** 8);
      } else if (gen.id === 'soft' && gen.softnessCurve) v = curveAt(gen.softnessCurve, d) / peak;
      else v = d <= fade ? 1 : 1 - (d - fade) / Math.max(1 - fade, 1e-6);
      data[y * side + x] = Math.round(Math.min(Math.max(v, 0), 1) * 255);
    }
  }
  return { width: side, height: side, data };
}

/** Krita's image tips paint with dark ink times alpha. RGBA image -> gray mask. */
export function imageMask(img) {
  const n = img.width * img.height, d = img.data, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const lum = (d[i * 4] * 19595 + d[i * 4 + 1] * 38470 + d[i * 4 + 2] * 7471 + 0x8000) >> 16;
    out[i] = ((255 - lum) * d[i * 4 + 3] + 127) / 255 | 0;
  }
  return { width: img.width, height: img.height, data: out };
}

/** One GIMP brush record (v1 or v2) at `offset`. */
export function readGbr(bytes, offset = 0) {
  const headerSize = be32(bytes, offset), version = be32(bytes, offset + 4);
  const width = be32(bytes, offset + 8), height = be32(bytes, offset + 12), depth = be32(bytes, offset + 16);
  if (!width || !height || width > 16384 || height > 16384 || ![1, 4].includes(depth)) throw new Error('not a GIMP brush');
  const nameStart = offset + (version === 1 ? 20 : 28);
  const name = utf8(bytes.subarray(nameStart, offset + headerSize)).replace(/\0+$/, '');
  const start = offset + headerSize, end = start + width * height * depth;
  if (end > bytes.length) throw new Error('GIMP brush data is truncated');
  const raw = bytes.subarray(start, end);
  let mask;
  if (depth === 1) mask = { width, height, data: Uint8Array.from(raw) };
  else mask = imageMask({ width, height, data: raw });
  return { name, mask, end, color: depth === 4 };
}

/** .gih (image hose): a name line, a parameter line, then GIMP brush records. */
export function readGih(bytes) {
  let p = bytes.indexOf(10);
  const name = utf8(bytes.subarray(0, p));
  const q = bytes.indexOf(10, p + 1);
  const params = utf8(bytes.subarray(p + 1, q));
  const count = parseInt(params, 10) || 1;
  const cells = [];
  for (let o = q + 1, i = 0; i < count && o < bytes.length; i++) {
    const g = readGbr(bytes, o);
    cells.push(g);
    o = g.end;
  }
  if (!cells.length) throw new Error('image hose has no brushes');
  return { name, params, cells };
}

/** GIMP pattern (.pat) -> RGBA image. */
export function readPat(bytes) {
  const headerSize = be32(bytes, 0), width = be32(bytes, 8), height = be32(bytes, 12), depth = be32(bytes, 16);
  if (latin1(bytes.subarray(20, 24)) !== 'GPAT') throw new Error('not a GIMP pattern');
  const src = bytes.subarray(headerSize, headerSize + width * height * depth);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = src.subarray(i * depth, i * depth + depth);
    const [r, g, b, a] = depth === 1 ? [s[0], s[0], s[0], 255] : depth === 2 ? [s[0], s[0], s[0], s[1]]
      : depth === 3 ? [s[0], s[1], s[2], 255] : [s[0], s[1], s[2], s[3]];
    data.set([r, g, b, a], i * 4);
  }
  return { width, height, data };
}

function base64Bytes(text) {
  const bin = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The pattern PNG Krita embeds in the preset (base64, sometimes base64 twice). */
export function embeddedPattern(params) {
  const v = params['Texture/Pattern/Pattern'];
  if (!v) return null;
  try {
    let bytes = base64Bytes(v);
    if (bytes[0] !== 0x89) bytes = base64Bytes(latin1(bytes));
    return bytes[0] === 0x89 ? bytes : null;
  } catch { return null; }
}

/* ── Containers ── */

// Engines that edit existing pixels instead of laying down paint.
export const NON_PAINT_ENGINES = { filter: 'filter', duplicate: 'clone', tangentnormal: 'tangent normal', deformbrush: 'deform' };
const stem = (name) => name.split('/').pop().replace(/\.[^.]+$/, '');
const base = (name) => name.split('/').pop().toLowerCase();
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

/**
 * files: [{name, data: Uint8Array}] — .bundle, .zip, .kpp, plus loose tips / patterns.
 * imaging: {decodeImage(bytes) -> RGBA, decodeSvg?(bytes) -> RGBA}
 * Returns {name, presets: [{name, engine, params, file, def, size, tips, texture, warnings}], skipped, errors}.
 */
export async function readKritaFiles(JSZip, files, imaging, onProgress = () => {}) {
  const resources = new Map(); // basename -> () => Promise<Uint8Array>
  const kpps = [];
  const errors = [];
  let bundleName = null;
  const addResource = (name, load) => { if (!resources.has(base(name))) resources.set(base(name), load); };

  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.bundle') || lower.endsWith('.zip')) {
      let zip;
      try { zip = await JSZip.loadAsync(f.data); } catch (e) { errors.push(`${f.name}: not a ZIP (${e.message})`); continue; }
      const meta = zip.file('meta.xml');
      if (meta && !bundleName) {
        const t = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(await meta.async('string'));
        if (t) bundleName = unescapeXml(t[1]).trim() || null;
      }
      bundleName ??= stem(f.name);
      for (const e of Object.values(zip.files)) {
        if (e.dir || e.name.includes('__MACOSX')) continue;
        if (/\.kpp$/i.test(e.name)) kpps.push({ name: e.name, load: () => e.async('uint8array') });
        else addResource(e.name, () => e.async('uint8array'));
      }
    } else if (lower.endsWith('.kpp')) kpps.push({ name: f.name, load: async () => f.data });
    else addResource(f.name, async () => f.data);
  }

  const imageCache = new Map();
  async function tipFromFile(def, warnings) {
    const key = base(def.filename || '');
    if (imageCache.has(key)) return imageCache.get(key);
    const load = resources.get(key);
    let result = null;
    if (!load) warnings.push(`tip file '${def.filename}' isn't in the files given; using a round tip`);
    else {
      try {
        const bytes = await load();
        if (/\.gih$/i.test(key)) {
          const gih = readGih(bytes);
          result = { masks: gih.cells.map((c) => c.mask), name: def.filename };
        } else if (/\.gbr$/i.test(key)) result = { masks: [readGbr(bytes).mask], name: def.filename };
        else if (/\.svg$/i.test(key)) {
          if (!imaging.decodeSvg) throw new Error('SVG tips need a browser');
          result = { masks: [imageMask(await imaging.decodeSvg(bytes))], name: def.filename };
        } else result = { masks: [imageMask(await imaging.decodeImage(bytes))], name: def.filename };
      } catch (e) {
        warnings.push(`tip '${def.filename}' couldn't be read (${e.message}); using a round tip`);
      }
    }
    imageCache.set(key, result);
    return result;
  }

  async function pattern(params, warnings) {
    let bytes = embeddedPattern(params), name = params['Texture/Pattern/Name'] || params['Texture/Pattern/PatternFileName'] || 'pattern';
    let image = null;
    try {
      if (bytes) image = await imaging.decodeImage(bytes);
      else {
        const file = params['Texture/Pattern/PatternFileName'] || params['Texture/Pattern/Name'];
        const load = file && resources.get(base(file));
        if (load) {
          bytes = await load();
          image = /\.pat$/i.test(file) ? readPat(bytes) : await imaging.decodeImage(bytes);
        }
      }
    } catch (e) { warnings.push(`texture '${name}' couldn't be read (${e.message})`); }
    if (!image) { warnings.push(`texture '${name}' isn't in the files given; texture dropped`); return null; }
    return {
      name: stem(name),
      gray: flattenGray(image),
      scale: num(params['Texture/Pattern/Scale'], 1),
      strength: num(params['Texture/Pattern/Strength'] ?? params['Texture/Strength/Value'] ?? params['Texture/StrengthValue'], 1),
      invert: params['Texture/Pattern/Invert'] === 'true',
      brightness: num(params['Texture/Pattern/Brightness'], 0),
      contrast: num(params['Texture/Pattern/Contrast'], 1),
      mode: num(params['Texture/Pattern/TexturingMode'], 0),
    };
  }

  const presets = [], skipped = [];
  for (const [i, k] of kpps.entries()) {
    onProgress(i + 1, kpps.length);
    let parsed;
    try {
      parsed = parsePresetXml(await parseKpp(await k.load()));
    } catch (e) { errors.push(`${k.name}: ${e.message}`); continue; }
    const { engine, params } = parsed;
    const name = parsed.name.replace(/_/g, ' ').trim() || stem(k.name);
    if (NON_PAINT_ENGINES[engine]) { skipped.push({ name, file: k.name, reason: `${NON_PAINT_ENGINES[engine]} engine edits pixels rather than painting` }); continue; }
    const warnings = [];
    const def = parseBrushDefinition(params.brush_definition);
    let tips = null, size = 20, tipLabel = 'round tip';
    if (!def) warnings.push(`the ${engine} engine has no brush tip; using a round tip`);
    else if (def.type === 'auto_brush' && def.mask) {
      const side = Math.min(Math.max(Math.round(def.mask.diameter), 128), 512);
      tips = { masks: [autoMask(def.mask, side)], name: null };
      size = def.mask.diameter;
      tipLabel = `generated ${def.mask.id === 'gauss' ? 'gaussian' : def.mask.id === 'soft' ? 'soft' : 'round'} ${def.mask.type} tip`;
      if (def.mask.spikes > 2) warnings.push(`${def.mask.spikes}-spike tip drawn as a plain ${def.mask.type}`);
    } else if (def.type === 'text_brush') warnings.push('text tip not supported; using a round tip');
    else if (def.filename) {
      tips = await tipFromFile(def, warnings);
      if (tips) {
        size = tips.masks[0].width * def.scale;
        tipLabel = `${tips.masks.length > 1 ? `${tips.masks.length}-image animated tip` : 'image tip'} '${def.filename}'`;
      }
    }
    if (!tips) size = def && def.mask ? def.mask.diameter : num(params['Spray/diameter'], size);
    const texture = params['Texture/Pattern/Enabled'] === 'true' ? await pattern(params, warnings) : null;
    presets.push({ name, engine, params, file: k.name, def, size: Math.max(size, 1), tips, tipLabel, texture, warnings });
  }
  return { name: bundleName, presets, skipped, errors };
}
