// GIMP brush (.gbr v2) and image hose (.gih) writers: Krita's animated brush tip.

import { concat, enc } from '../bytes.js';

function gbr(mask, name, spacingPercent) {
  const nameBytes = concat([enc.encode(name), new Uint8Array([0])]);
  const header = new Uint8Array(28);
  const dv = new DataView(header.buffer);
  [28 + nameBytes.length, 2, mask.width, mask.height, 1, 0x47494D50, Math.trunc(spacingPercent)]
    .forEach((v, i) => dv.setUint32(i * 4, v >>> 0, false)); // 0x47494D50 = "GIMP"
  return concat([header, nameBytes, mask.data]);
}

/** Pack several square masks into one .gih; returns {data, side}. */
export function masksToGih(masks, name, randomOrder, spacingPercent) {
  const side = Math.max(...masks.map((m) => Math.max(m.width, m.height)));
  const cells = masks.map((m) => {
    const data = new Uint8Array(side * side);
    const ox = (side - m.width) >> 1, oy = (side - m.height) >> 1;
    for (let y = 0; y < m.height; y++) data.set(m.data.subarray(y * m.width, (y + 1) * m.width), (y + oy) * side + ox);
    return { width: side, height: side, data };
  });
  const sel = randomOrder ? 'random' : 'incremental';
  const params = `${cells.length} ncells:${cells.length} cellwidth:${side} cellheight:${side} `
    + `step:100 dim:1 cols:1 rows:1 placement:constant rank0:${cells.length} sel0:${sel}`;
  const parts = [enc.encode(`${name}\n${params}\n`)];
  cells.forEach((cell, k) => parts.push(gbr(cell, `${name} ${k + 1}`, spacingPercent)));
  return { data: concat(parts), side };
}
