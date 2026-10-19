// Write Procreate .brush (one brush) and .brushset (several) ZIPs. Uses the JSZip passed in.

import { buildBrushArchive, writeBplist } from '../bplist.js';

export function uuid() {
  return globalThis.crypto && crypto.randomUUID ? crypto.randomUUID().toUpperCase()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16).toUpperCase(); });
}

/** brush: {params, shapePng, grainPng?, thumbPng?}; files go under `prefix` ('' or 'UUID/'). */
function addBrush(zip, brush, prefix = '') {
  zip.file(`${prefix}Brush.archive`, buildBrushArchive(brush.params));
  zip.file(`${prefix}Shape.png`, brush.shapePng);
  if (brush.grainPng) zip.file(`${prefix}Grain.png`, brush.grainPng);
  if (brush.thumbPng) zip.file(`${prefix}QuickLook/Thumbnail.png`, brush.thumbPng);
}

const generate = (zip) => zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });

/** A single .brush. Returns a Blob. */
export function writeBrush(JSZip, brush) {
  const zip = new JSZip();
  addBrush(zip, brush);
  return generate(zip);
}

/**
 * A .brushset: one folder per brush, named by its UUID, plus brushset.plist
 * ({name, brushes: [folder, ...]}, a plain binary plist). Returns a Blob.
 */
export function writeBrushset(JSZip, name, brushes) {
  const zip = new JSZip();
  const folders = brushes.map((b) => {
    const id = b.params.signedID || uuid();
    addBrush(zip, b, `${id}/`);
    return id;
  });
  zip.file('brushset.plist', writeBplist({ name, brushes: folders }));
  return generate(zip);
}
