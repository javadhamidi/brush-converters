// Krita .kpp presets: a PNG thumbnail with the preset XML in a text chunk.

import { concat, crc32, enc } from '../bytes.js';
import { canvasToPng, makeCanvas, maskToCanvas } from '../image.js';

export const THUMB = 200;

const xmlAttr = (v) => `"${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"`;

export function presetXml(preset) {
  const parts = [`<Preset paintopid="paintbrush" name=${xmlAttr(preset.name)}>`];
  for (const name of Object.keys(preset.params).sort()) {
    const v = preset.params[name];
    const [type, value] = Array.isArray(v) ? v : ['string', v];
    parts.push(`<param name=${xmlAttr(name)} type="${type}"><![CDATA[${value}]]></param>`);
  }
  parts.push('</Preset>');
  return parts.join(' ');
}

function chunk(type, data) {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length, false);
  head.set(enc.encode(type), 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concat([head.subarray(4), data])), false);
  return concat([head, data, crc]);
}

const isLatin1 = (s) => /^[\x00-\xff]*$/.test(s);
const latin1 = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

/** Insert text chunks right after IHDR, before the image data, where readers that only
 *  parse the header (and Krita's own writer) put them. tEXt for Latin-1, else iTXt (UTF-8). */
export function pngWithText(png, entries) {
  const afterIhdr = 8 + 12 + 13; // signature + IHDR chunk
  const chunks = Object.entries(entries).map(([key, text]) => (isLatin1(text)
    ? chunk('tEXt', concat([latin1(key), new Uint8Array([0]), latin1(text)]))
    : chunk('iTXt', concat([latin1(key), new Uint8Array([0, 0, 0, 0, 0]), enc.encode(text)]))));
  return concat([png.subarray(0, afterIhdr), ...chunks, png.subarray(afterIhdr)]);
}

function curveAt(points, x) {
  if (!points) return 1;
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    if (x0 <= x && x <= x1) return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const maskCanvases = new WeakMap();

/** Sample S-stroke with a pressure ramp, dark ink on white. Returns a canvas. */
export function renderStroke(dab, width = THUMB, height = THUMB) {
  const rand = rng(1);
  const ink = makeCanvas(width, height);
  const ctx = ink.getContext('2d');
  if (!maskCanvases.has(dab.mask)) maskCanvases.set(dab.mask, maskToCanvas(dab.mask));
  const tip = maskCanvases.get(dab.mask);
  const display = Math.min(Math.max(dab.size, 8), 46);
  const margin = display * 0.6 + 6;
  const length = width - 2 * margin;
  ctx.globalAlpha = dab.flow;
  ctx.imageSmoothingQuality = 'high';
  for (let t = 0; t <= 1;) {
    const x = margin + length * t;
    const y = height / 2 + Math.sin(t * 2 * Math.PI) * (height / 2 - margin);
    const pressure = Math.sin(t * Math.PI) ** 0.7;
    const d = Math.max(display * curveAt(dab.sizeCurve, pressure), 1);
    let angle = dab.angle;
    if (dab.followLine) angle += (Math.atan2(-Math.cos(t * 2 * Math.PI), 1) * 180 / Math.PI) * 0.9;
    if (dab.randomRotation) angle += rand() * 360;
    let cx = x, cy = y;
    if (dab.scatter) {
      cx += (rand() * 2 - 1) * dab.scatter * d;
      cy += (rand() * 2 - 1) * dab.scatter * d;
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-angle * Math.PI) / 180);
    ctx.drawImage(tip, -d / 2, (-d * dab.ratio) / 2, d, d * dab.ratio);
    ctx.restore();
    t += Math.max(d * dab.spacing, 0.6) / (length * 1.35);
  }
  if (dab.pattern) {
    // Multiply the ink by the texture (dark texture = paint), tiled at its CSP scale.
    const p = dab.pattern;
    const scale = dab.patternScale * Math.min(1, 46 / Math.max(dab.size, 1));
    const tw = Math.max(Math.floor(p.width * scale), 2), th = Math.max(Math.floor(p.height * scale), 2);
    const tex = makeCanvas(tw, th);
    const tctx = tex.getContext('2d');
    const src = new Uint8ClampedArray(p.data.length);
    for (let i = 0; i < p.data.length; i += 4) {
      const a = p.data[i + 3] / 255;
      const lum = (0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2]) * a + 255 * (1 - a);
      src[i + 3] = 90 + ((255 - lum) * 165) / 255;
    }
    const full = makeCanvas(p.width, p.height);
    full.getContext('2d').putImageData(new ImageData(src, p.width, p.height), 0, 0);
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(full, 0, 0, tw, th);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = ctx.createPattern(tex, 'repeat');
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }
  // Colour the ink and lay it on white.
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = 'rgb(20,20,20)';
  ctx.fillRect(0, 0, width, height);
  const out = makeCanvas(width, height);
  const octx = out.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, width, height);
  octx.globalAlpha = dab.opacity;
  octx.drawImage(ink, 0, 0);
  return out;
}

/** -> {data: .kpp bytes, thumbnail: canvas} */
export async function kppBytes(preset) {
  const thumbnail = renderStroke(preset.dab);
  const png = await canvasToPng(thumbnail);
  return { data: pngWithText(png, { version: '2.2', preset: presetXml(preset) }), thumbnail };
}
