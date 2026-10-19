// Minimal POSIX tar reader/writer (CSP stores materials as tar archives).

import { enc } from './bytes.js';

/** Returns [{name, data}] for every regular file in the archive. */
export function parseTar(data) {
  const files = [];
  let off = 0;
  while (off + 512 <= data.length) {
    let n = 0;
    while (n < 100 && data[off + n] !== 0) n++;
    if (n === 0) break;
    const name = new TextDecoder().decode(data.subarray(off, off + n));
    let sizeStr = '';
    for (let i = 124; i < 136; i++) {
      const b = data[off + i];
      if (b >= 0x30 && b <= 0x37) sizeStr += String.fromCharCode(b);
    }
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const type = data[off + 156];
    if ((type === 0 || type === 0x30) && off + 512 + size <= data.length) {
      files.push({ name, data: data.subarray(off + 512, off + 512 + size) });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function buildTar(entries) {
  const blocks = [];
  for (const { name, data } of entries) {
    const hdr = new Uint8Array(512);
    hdr.set(enc.encode(name).slice(0, 100), 0);
    hdr.set(enc.encode('0000644\0'), 100);
    hdr.set(enc.encode('0001000\0'), 108);
    hdr.set(enc.encode('0001000\0'), 116);
    hdr.set(enc.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124);
    hdr.set(enc.encode(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0'), 136);
    hdr.set(enc.encode('        '), 148);
    hdr[156] = 0x30;
    hdr.set(enc.encode('ustar\0'), 257);
    hdr.set(enc.encode('00'), 263);
    let ck = 0;
    for (let i = 0; i < 512; i++) ck += hdr[i];
    hdr.set(enc.encode(ck.toString(8).padStart(6, '0') + '\0 '), 148);
    const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
    body.set(data);
    blocks.push(hdr, body);
  }
  blocks.push(new Uint8Array(1024));
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}
