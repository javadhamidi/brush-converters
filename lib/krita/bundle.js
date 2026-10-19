// Krita resource bundle (.bundle): a zip with a manifest. Uses the JSZip global.

import { hex, md5 } from '../bytes.js';
import { canvasToPng, makeCanvas } from '../image.js';

export const MIMETYPE = 'application/x-krita-resourcebundle';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function manifest(entries, tag) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">',
    ` <manifest:file-entry manifest:media-type="${MIMETYPE}" manifest:full-path="/"/>`];
  for (const { kind, path, data } of entries) {
    const head = ` <manifest:file-entry manifest:media-type="${kind}" manifest:full-path="${esc(path)}" manifest:md5sum="${hex(md5(data))}"`;
    if (kind === 'paintoppresets' && tag) {
      lines.push(`${head}>`, `  <manifest:tags><manifest:tag>${esc(tag)}</manifest:tag></manifest:tags>`, ' </manifest:file-entry>');
    } else lines.push(`${head}/>`);
  }
  lines.push('</manifest:manifest>');
  return `${lines.join('\n')}\n`;
}

function meta(name, author, description) {
  const now = new Date().toISOString().slice(0, 19);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<meta:meta>\n'
    + ' <meta:generator>brush-converters</meta:generator>\n'
    + ' <meta:bundle-version>1</meta:bundle-version>\n'
    + ` <dc:title>${esc(name)}</dc:title>\n`
    + ` <dc:author>${esc(author)}</dc:author>\n`
    + ` <dc:description>${esc(description)}</dc:description>\n`
    + ` <meta:initial-creator>${esc(author)}</meta:initial-creator>\n`
    + ` <dc:creator>${esc(author)}</dc:creator>\n`
    + ` <meta:creation-date>${now}</meta:creation-date>\n`
    + ` <meta:dc-date>${now}</meta:dc-date>\n`
    + ' <meta:meta-userdefined meta:name="email" meta:value=""/>\n'
    + ' <meta:meta-userdefined meta:name="license" meta:value=""/>\n'
    + ' <meta:meta-userdefined meta:name="website" meta:value=""/>\n'
    + '</meta:meta>\n';
}

async function preview(thumbs, side = 256) {
  const c = makeCanvas(side, side);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(thumbs.length))));
  const cell = Math.floor(side / cols);
  thumbs.slice(0, cols * cols).forEach((t, k) => ctx.drawImage(t, (k % cols) * cell, Math.floor(k / cols) * cell, cell, cell));
  return canvasToPng(c);
}

/**
 * presets: [{filename, data, thumbnail}], resources: [{kind, filename, data}]
 * Returns a Blob.
 */
export async function writeBundle(JSZip, presets, resources, { name, author = '', description = '', tag = null }) {
  const entries = [
    ...resources.map((r) => ({ kind: r.kind, path: `${r.kind}/${r.filename}`, data: r.data })),
    ...presets.map((p) => ({ kind: 'paintoppresets', path: `paintoppresets/${p.filename}`, data: p.data })),
  ];
  const zip = new JSZip();
  const opts = { createFolders: false }; // no directory entries, like Krita's own bundles
  zip.file('mimetype', MIMETYPE, { ...opts, compression: 'STORE' });
  for (const e of entries) zip.file(e.path, e.data, opts);
  zip.file('preview.png', await preview(presets.map((p) => p.thumbnail)), opts);
  zip.file('meta.xml', meta(name, author, description), opts);
  zip.file('META-INF/manifest.xml', manifest(entries, tag), opts);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
