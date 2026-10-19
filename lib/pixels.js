// Pure pixel operations on plain {width, height, data} buffers (DOM-free).
// Integer maths follows Pillow's so results match the Python reference converter.

const div255 = (v) => { const t = v + 128; return ((t >> 8) + t) >> 8; };
const luma = (r, g, b) => (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;

/** Grayscale mask {width, height, data: Uint8Array} where 255 = full paint.
 *  CSP takes the tip shape from transparency (white-on-transparent tips paint
 *  normally); fully opaque images carry their shape in the tones, darker = denser. */
export function coverage(img) {
  const n = img.width * img.height, d = img.data;
  const alpha = new Uint8Array(n), gray = new Uint8Array(n);
  let aLo = 255, aHi = 0, gLo = 255, gHi = 0;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3], g = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    alpha[i] = a; gray[i] = g;
    if (a < aLo) aLo = a; if (a > aHi) aHi = a;
    if (g < gLo) gLo = g; if (g > gHi) gHi = g;
  }
  if (aLo === aHi && gLo !== gHi) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = aHi < 255 ? div255((255 - gray[i]) * alpha[i]) : 255 - gray[i];
    return { width: img.width, height: img.height, data: out };
  }
  return { width: img.width, height: img.height, data: alpha };
}

export function isEmpty(mask) {
  for (const v of mask.data) if (v) return false;
  return true;
}

/** Centre a mask on a square canvas (margins kept: CSP centres tips on the whole image). */
export function padSquare(mask) {
  const side = Math.max(mask.width, mask.height);
  if (mask.width === side && mask.height === side) return mask;
  const out = new Uint8Array(side * side);
  const ox = (side - mask.width) >> 1, oy = (side - mask.height) >> 1;
  for (let y = 0; y < mask.height; y++) {
    out.set(mask.data.subarray(y * mask.width, (y + 1) * mask.width), (y + oy) * side + ox);
  }
  return { width: side, height: side, data: out };
}

/** RGBA flattened onto white and converted to luminance (how a pattern looks in CSP). */
export function flattenGray(img) {
  const n = img.width * img.height, d = img.data, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    const c = (k) => div255(255 * (255 - a) + d[i * 4 + k] * a);
    out[i] = luma(c(0), c(1), c(2));
  }
  return { width: img.width, height: img.height, data: out };
}

/** Pillow's Image.thumbnail() target size for fitting into a max x max box. */
export function thumbnailSize(width, height, max) {
  if (max >= width && max >= height) return [width, height];
  const aspect = width / height;
  const roundAspect = (num, key) => {
    const f = Math.floor(num), c = Math.ceil(num);
    return Math.max(key(f) <= key(c) ? f : c, 1);
  };
  if (max / max >= aspect) {
    return [roundAspect(max * aspect, (n) => Math.abs(aspect - n / max)), max];
  }
  return [max, roundAspect(max / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - max / n)))];
}
