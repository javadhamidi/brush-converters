// Browser image helpers: canvas resizing, PNG encode/decode, and the `imaging`
// backend that lib/krita/mapping.js expects.

import { coverage, flattenGray, isEmpty, padSquare, thumbnailSize } from './pixels.js';
import { grayPng, maskPng } from './png.js';

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export async function canvasToPng(c) {
  const blob = c.convertToBlob
    ? await c.convertToBlob({ type: 'image/png' })
    : await new Promise((ok) => c.toBlob(ok, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** PNG/JPEG bytes -> {width, height, data: RGBA}. */
export async function decodeImage(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = makeCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const id = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: id.data };
}

/** RGBA buffer -> canvas. */
export function imageToCanvas(img) {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

/** Gray mask -> canvas. mode 'alpha': black ink with alpha = mask (Krita tips);
 *  'white': white-on-black opaque (Procreate Shape.png); 'gray': opaque gray. */
export function maskToCanvas(mask, mode = 'alpha') {
  const n = mask.width * mask.height;
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = mask.data[i];
    if (mode === 'alpha') px[i * 4 + 3] = v;
    else { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
  }
  const c = makeCanvas(mask.width, mask.height);
  c.getContext('2d').putImageData(new ImageData(px, mask.width, mask.height), 0, 0);
  return c;
}

function readChannel(c, channel) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + channel];
  return out;
}

/** High-quality resize of a gray mask. */
export function resizeMask(mask, width, height = width, mode = 'alpha') {
  if (mask.width === width && mask.height === height) return mask;
  const c = makeCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (mode !== 'alpha') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height); }
  ctx.drawImage(maskToCanvas(mask, mode), 0, 0, width, height);
  return { width, height, data: readChannel(c, mode === 'alpha' ? 3 : 0) };
}

export const browserImaging = {
  async tipMask(image, maxTip) {
    const cov = coverage(image);
    if (isEmpty(cov)) return null;
    const square = padSquare(cov);
    const mask = square.width > maxTip ? resizeMask(square, maxTip) : square;
    return { mask, png: await maskPng(mask) };
  },
  async pattern(image) {
    const gray = flattenGray(image);
    const [width, height] = thumbnailSize(gray.width, gray.height, 2048);
    const sized = resizeMask(gray, width, height, 'gray');
    return { png: await grayPng(sized), width, height };
  },
  circleMask(hardness) {
    const side = 256;
    const c = makeCanvas(side, side);
    const ctx = c.getContext('2d');
    if (hardness < 1) ctx.filter = `blur(${side * 0.25 * (1 - hardness)}px)`;
    ctx.beginPath();
    ctx.arc(side / 2, side / 2, side / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    return { width: side, height: side, data: readChannel(c, 3) };
  },
};

/** SVG bytes -> {width, height, data: RGBA}, rasterised with its longest side at `side` px. */
export async function decodeSvg(bytes, side = 512) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || side, h = img.naturalHeight || side;
    const k = side / Math.max(w, h);
    const c = makeCanvas(Math.max(Math.round(w * k), 1), Math.max(Math.round(h * k), 1));
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fit a gray mask inside max x max (keeps aspect). */
export function fitMask(mask, max, mode = 'alpha') {
  const k = max / Math.max(mask.width, mask.height);
  return k < 1 ? resizeMask(mask, Math.max(Math.round(mask.width * k), 1), Math.max(Math.round(mask.height * k), 1), mode) : mask;
}
