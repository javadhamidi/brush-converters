// Shared page plumbing: pipeline stages, result panel, drop zone, downloads, sql.js loading.

const SQLJS_CDN = new URL('../vendor/sql.js/1.8.0/', import.meta.url).href;

const $ = (id) => document.getElementById(id);

/** Append a line to stage n's log. cls: g ok, c accent, w warn, r error, d dim, l code. */
export function log(n, text, cls = '') {
  const el = $(`o${n}`);
  const line = document.createElement('span');
  line.className = cls;
  line.textContent = `${text}\n`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

const LABELS = { wait: 'pending', run: 'running', ok: 'done', err: 'error' };

export function badge(n, state) {
  const b = $(`b${n}`);
  b.className = `stg-badge ${state}`;
  b.textContent = LABELS[state];
  $(`s${n}`).className = `stg${state === 'wait' ? '' : ` ${state}`}`;
}

/** Show progress on a running stage, e.g. progress(2, 12, 30). Also mirrored in the result panel. */
export function progress(n, done, total) {
  $(`b${n}`).textContent = `${LABELS.run} ${done}/${total}`;
  const name = $(`s${n}`).querySelector('.stg-name');
  setResult({ state: 'run', title: `${name ? name.textContent : 'Working'}… ${done}/${total}` });
}

/** Clear the pipeline for a new run and show "working" in the result panel. */
export function resetStages(count, title = 'Converting…') {
  for (let i = 1; i <= count; i++) {
    badge(i, 'wait');
    $(`o${i}`).replaceChildren();
  }
  document.querySelector('.pipeline')?.classList.add('started');
  $('drop')?.classList.remove('failed');
  setResult({ state: 'run', title });
}

/** Mark whichever stage is running as failed, print the error there and in the result panel. */
export function failRunning(count, err, hint = '') {
  console.error(err);
  const msg = err && err.message ? err.message : String(err);
  for (let i = 1; i <= count; i++) {
    if ($(`b${i}`).textContent.startsWith(LABELS.run)) {
      badge(i, 'err');
      log(i, `\n! ${msg}`, 'r');
      break;
    }
  }
  $('drop')?.classList.add('failed');
  $('drop')?.classList.remove('loaded');
  setResult({ state: 'err', title: `Couldn't convert: ${msg}`, detail: hint || 'The step that failed is marked below.' });
}

/* ── Result panel: a single place, right under the drop zone, for status and downloads ── */

function resultPanel() {
  let el = $('result');
  if (el) return el;
  el = document.createElement('section');
  el.id = 'result';
  el.className = 'result';
  el.hidden = true;
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<div class="result-main"><div class="result-title"></div><div class="result-detail"></div></div><div class="result-actions"></div>';
  $('drop').after(el);
  return el;
}

/**
 * state: 'run' | 'ok' | 'err'; actions: [{label, onClick, primary}].
 * On success the primary action gets focus and the panel scrolls into view.
 */
export function setResult({ state, title, detail = '', actions = [] }) {
  const el = resultPanel();
  el.hidden = false;
  el.className = `result ${state}`;
  el.querySelector('.result-title').textContent = title;
  const d = el.querySelector('.result-detail');
  d.textContent = detail;
  d.hidden = !detail;
  const box = el.querySelector('.result-actions');
  box.replaceChildren(...actions.map((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = a.primary ? 'dl-btn' : 'ghost-btn';
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    return b;
  }));
  if (state === 'ok') {
    box.querySelector('.dl-btn')?.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** "Show details" action: jump to the pipeline log. */
export const detailsAction = { label: 'Show steps', onClick: () => document.querySelector('.pipeline')?.scrollIntoView({ behavior: 'smooth' }) };

/* ── Drop zone ── */

function readEntries(reader) {
  return new Promise((ok, no) => reader.readEntries(ok, no));
}

async function filesFromEntry(entry, out) {
  if (entry.isFile) {
    out.push(await new Promise((ok, no) => entry.file(ok, no)));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
      for (const e of batch) await filesFromEntry(e, out);
    }
  }
}

/**
 * Wire up a drop zone; onFiles receives an array of File.
 * Dropped folders are searched recursively for files whose names end in one of `accept`.
 */
export function setupDrop({ zone = 'drop', input = 'fi', label = 'dropFile', accept = null, onFiles }) {
  const dz = $(zone), fi = $(input), lbl = $(label);
  const keep = (f) => !accept || accept.some((ext) => f.name.toLowerCase().endsWith(ext));
  const go = (files) => {
    const list = [...files].filter(keep);
    if (!list.length) {
      dz.classList.add('failed');
      dz.classList.remove('loaded');
      lbl.textContent = accept ? `No ${accept.join(' / ')} files found in what was dropped` : 'Nothing to convert';
      return;
    }
    dz.classList.remove('failed');
    dz.classList.add('loaded');
    const kb = list.reduce((s, f) => s + f.size, 0) / 1024;
    const size = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(1)} KB`;
    lbl.textContent = list.length === 1 ? `${list[0].name} (${size})` : `${list.length} files (${size})`;
    onFiles(list);
  };
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.some((en) => en.isDirectory)) {
      const out = [];
      for (const en of entries) await filesFromEntry(en, out);
      go(out);
    } else go(e.dataTransfer.files);
  });
  fi.addEventListener('change', (e) => { go(e.target.files); fi.value = ''; });
}

/**
 * Wrap a long async job so a new request made while it runs waits, and only the
 * newest waiting request runs next (dropping files twice doesn't interleave two runs).
 */
export function latestOnly(job) {
  let running = false, pending = null;
  const request = async (...args) => {
    if (running) { pending = args; return; }
    running = true;
    try { await job(...args); } finally {
      running = false;
      if (pending) { const next = pending; pending = null; request(...next); }
    }
  };
  return request;
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function formatSize(bytes) {
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

let sqlPromise = null;
export function loadSql() {
  sqlPromise ||= window.initSqlJs({ locateFile: (f) => SQLJS_CDN + f });
  return sqlPromise;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Draw a canvas (or RGBA image) into a preview canvas element. */
export function showCanvas(id, source) {
  const cv = $(id);
  cv.width = source.width;
  cv.height = source.height;
  cv.getContext('2d').drawImage(source, 0, 0);
}

/** File objects -> [{name, data: Uint8Array}] for the DOM-free readers. */
export function readFiles(files) {
  return Promise.all([...files].map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
}

/** Preview card for a tip or texture: a canvas plus a caption ("<b>role</b> detail"). */
export function imageCard(canvas, role, detail, light = true) {
  const card = document.createElement('div');
  card.className = 'tex-card';
  const shown = document.createElement('canvas');
  shown.width = canvas.width; shown.height = canvas.height;
  shown.getContext('2d').drawImage(canvas, 0, 0);
  shown.className = `${light ? 'light' : ''}${Math.max(canvas.width, canvas.height) < 160 ? ' px' : ''}`.trim();
  shown.setAttribute('role', 'img');
  shown.setAttribute('aria-label', `${role} ${detail}`);
  const lbl = document.createElement('div');
  lbl.className = 'tex-lbl';
  lbl.innerHTML = `<b>${escapeHtml(role)}</b> ${escapeHtml(detail)}`;
  card.append(shown, lbl);
  return card;
}

/** Result card for one converted brush: sample stroke, name, file, what carried over and what didn't. */
export function brushCard({ name, filename, thumbnail, mapped = [], warnings = [] }) {
  const card = document.createElement('div');
  card.className = 'brush-card';
  const cv = document.createElement('canvas');
  cv.width = thumbnail.width; cv.height = thumbnail.height;
  cv.getContext('2d').drawImage(thumbnail, 0, 0);
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', `Sample stroke for ${name}`);
  const items = [...mapped.map((m) => `<li class="m">${escapeHtml(m)}</li>`),
    ...[...new Set(warnings)].map((w) => `<li class="x">${escapeHtml(w)}</li>`)];
  const body = document.createElement('div');
  body.className = 'bc-body';
  body.innerHTML = `<div class="bc-name">${escapeHtml(name)}</div><div class="bc-file">${escapeHtml(filename)}</div><ul>${items.join('')}</ul>`;
  card.append(cv, body);
  return card;
}

/** Name a set of output files uniquely (case-insensitively), e.g. "Pencil.kpp", "Pencil_2.kpp". */
export function uniqueNamer() {
  const used = new Set();
  return (stem, ext) => {
    let name = `${stem}${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}_${n}${ext}`;
    used.add(name.toLowerCase());
    return name;
  };
}
