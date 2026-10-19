// Big-endian reading for Photoshop's binary formats (.abr brushes, patterns, action
// descriptors), and the PackBits RLE rows they use for pixels. DOM-free.

const latin1 = new TextDecoder('latin1');
const utf16be = new TextDecoder('utf-16be');

export class Cursor {
  constructor(bytes, offset = 0, end = bytes.length) {
    this.buf = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
    this.end = end;
  }

  get left() { return this.end - this.offset; }

  need(n) {
    if (n < 0 || this.offset + n > this.end) throw new Error(`unexpected end of data at byte ${this.offset} (wanted ${n} more)`);
  }

  take(n, read) {
    this.need(n);
    const v = read(this.offset);
    this.offset += n;
    return v;
  }

  u8() { return this.take(1, (o) => this.buf[o]); }
  u16() { return this.take(2, (o) => this.dv.getUint16(o)); }
  i16() { return this.take(2, (o) => this.dv.getInt16(o)); }
  u32() { return this.take(4, (o) => this.dv.getUint32(o)); }
  i32() { return this.take(4, (o) => this.dv.getInt32(o)); }
  f64() { return this.take(8, (o) => this.dv.getFloat64(o)); }
  i64() { return this.take(8, (o) => Number(this.dv.getBigInt64(o))); }
  bytes(n) { return this.take(n, (o) => this.buf.subarray(o, o + n)); }
  skip(n) { this.take(n, () => null); }

  /** A four-character code such as '8BIM' or 'Objc'. */
  sig() { return latin1.decode(this.bytes(4)); }

  /** Descriptor class / key ID: a length, or 0 for a four-character code. */
  key() { return latin1.decode(this.bytes(this.u32() || 4)); }

  /** u32 count of UTF-16BE code units; Photoshop usually adds a trailing NUL. */
  unicode() { return utf16be.decode(this.bytes(this.u32() * 2)).replace(/\0+$/, ''); }

  pascal() { return latin1.decode(this.bytes(this.u8())); }

  /** A cursor over the next n bytes (advancing past them). */
  sub(n) {
    this.need(n);
    const c = new Cursor(this.buf, this.offset, this.offset + n);
    this.offset += n;
    return c;
  }
}

/** One PackBits-compressed row into out[at .. at + width). Stops at the row's end on bad data. */
export function unpackBits(src, out, at, width) {
  let x = 0;
  for (let i = 0; i < src.length && x < width;) {
    const n = src[i++];
    if (n < 128) {
      for (let k = 0; k <= n && x < width && i < src.length; k++) out[at + x++] = src[i++];
    } else if (n > 128) {
      const v = src[i++];
      for (let k = 0; k <= 256 - n && x < width; k++) out[at + x++] = v;
    } // 128 is a no-op
  }
}

/** `rows` rows of `rowBytes` bytes, raw (compression 0) or PackBits with u16 row lengths first (1). */
export function readRows(cur, rows, rowBytes, compression) {
  if (compression === 0) return Uint8Array.from(cur.bytes(rows * rowBytes));
  if (compression !== 1) throw new Error(`unknown compression ${compression}`);
  const lengths = Array.from({ length: rows }, () => cur.u16());
  const out = new Uint8Array(rows * rowBytes);
  lengths.forEach((n, y) => unpackBits(cur.bytes(n), out, y * rowBytes, rowBytes));
  return out;
}

/** 8-bit samples from 8- or 16-bit (big-endian) data: 16-bit keeps the high byte. */
export function toEightBit(data, depth) {
  if (depth === 8) return data;
  if (depth !== 16) throw new Error(`${depth}-bit pixels aren't supported`);
  const out = new Uint8Array(data.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 2];
  return out;
}
