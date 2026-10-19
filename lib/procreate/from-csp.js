// Map a CSP brush (lib/csp/sut.js readSut) onto Procreate brush settings
// (lib/procreate/settings.js). DOM-free; the tip and grain images are handled by the page.

import { isBytes } from '../bytes.js';
import { describeEffector, parseEffector } from '../csp/effector.js';
import { IMAGE_COLUMNS, parseImageRefs } from '../csp/sut.js';
import { spacingFor } from '../krita/mapping.js';
import { defaultSettings } from './settings.js';

const pct = (v) => (v || 0) / 100;
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

// CSP column -> settings field. f: dir(ect) / apx (approximate) / non (no equivalent).
// Spacing, effectors and rotation dynamics are handled separately below.
const RMAP = {
  BrushSize: { k: 'size', key: 'maxSize', f: 'dir', fn: (v) => v || 20 },
  Opacity: { k: 'opacity', key: 'paintOpacity', f: 'dir', fn: (v) => (v ?? 100) / 100 },
  BrushFlow: { k: 'flow', key: 'dynamicsGlazedFlow', f: 'apx', fn: (v) => (v ?? 100) / 100 },
  BrushThickness: { k: 'roundness', key: 'shapeRoundness', f: 'dir', fn: (v) => Math.min(1, Math.max((v || 100) / 100, 0.01)) },
  BrushRotation: { k: 'angle', key: 'shapeAngle', f: 'dir', fn: (v) => v || 0 },
  BrushRevision: { k: 'streamline', key: 'plotSmoothing', f: 'apx', fn: (v) => Math.min(1, (v || 0) / 20) },
  BrushInLength: { k: 'taperStart', key: 'taperStartLength', f: 'apx', fn: (v) => clamp01(pct(v)) },
  BrushOutLength: { k: 'taperEnd', key: 'taperEndLength', f: 'apx', fn: (v) => clamp01(pct(v)) },
  TextureDensity: { k: 'grainDepth', key: 'grainDepth', f: 'apx', fn: (v) => clamp01(pct(v)) },
  TextureScale2: { k: 'grainScale', key: 'textureScale', f: 'apx', fn: (v) => (v || 100) / 100 },
  BrushPatternReverseHorizontal: { k: 'flipX', key: 'shapeFlipXJitter', f: 'apx', fn: (v) => !!v },
  BrushPatternReverseVertical: { k: 'flipY', key: 'shapeFlipYJitter', f: 'apx', fn: (v) => !!v },
  // Columns written by this project's older Procreate -> CSP converter (minimal .sut files).
  Gap: { k: 'spacing', key: 'plotSpacing', f: 'dir', fn: (v) => (v || 10) / 100 },
  BrushSizeMin: { k: 'pressureSize', key: 'dynamicsPressureSize', f: 'dir', fn: (v, row) => (row.BrushSize > 0 ? clamp01(1 - (v || 0) / row.BrushSize) : 0) },
  PaintOpacity: { k: 'opacity', key: 'paintOpacity', f: 'dir', fn: (v) => (v ?? 100) / 100 },
  PaintOpacityMin: { k: 'pressureOpacity', key: 'dynamicsPressureOpacity', f: 'dir', fn: (v) => clamp01(1 - pct(v)) },
  Stabilization: { k: 'streamline', key: 'plotSmoothing', f: 'apx', fn: (v) => Math.min(1, (v || 0) / 50) },
  Direction: { k: 'angle', key: 'shapeAngle', f: 'dir', fn: (v) => v || 0 },
  Thickness: { k: 'roundness', key: 'shapeRoundness', f: 'dir', fn: (v) => clamp01((v || 100) / 100) || 1 },
  FlipHorizontal: { k: 'flipX', key: 'shapeFlipXJitter', f: 'dir', fn: (v) => !!v },
  FlipVertical: { k: 'flipY', key: 'shapeFlipYJitter', f: 'dir', fn: (v) => !!v },
  DynSpeedSize: { k: 'speedSize', key: 'dynamicsSpeedSize', f: 'dir', fn: (v) => v || 0 },
  DynSpeedOpacity: { k: 'speedOpacity', key: 'dynamicsSpeedOpacity', f: 'dir', fn: (v) => v || 0 },
  Oriented: { k: 'followStroke', key: 'shapeRotation', f: 'dir', fn: (v) => !!v },
  // No Procreate counterpart, but worth listing.
  BrushMixColor: { f: 'non' },
  BrushMixAlpha: { f: 'non' },
  BrushSprayDensity: { f: 'non' },
  CompositeMode: { f: 'non' },
};
const SKIP = new Set(['_PW_ID', 'VariantID', 'VariantId', 'VariantShowSeparator', 'VariantShowParam']);
const fmtVal = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v));

/**
 * brush: from readSut. Returns {settings, warnings, rows: [[csp, value, procreate, fidelity]],
 * counts: {dir, apx, non, unmapped}}.
 */
export function cspToSettings(brush) {
  const p = brush.params;
  const s = defaultSettings(brush.name);
  const warnings = [...brush.warnings];
  const rows = [];
  const counts = { dir: 0, apx: 0, non: 0, unmapped: 0 };
  const add = (cells, f) => { rows.push([...cells, f]); counts[f === 'image' ? 'dir' : f] += 1; };

  for (const col of Object.keys(p)) {
    const val = p[col];
    if (SKIP.has(col) || val == null) continue;
    if (IMAGE_COLUMNS.includes(col)) {
      const refs = parseImageRefs(val).map((r) => r.name || r.path).join(', ');
      add([col, refs || '-', col === 'TextureImage' ? 'Grain.png' : col === 'DualPatternImageArray' ? '(dual brush: dropped)' : 'Shape.png'], 'image');
      continue;
    }
    if (isBytes(val)) {
      // Size and opacity effectors are mapped below; list other active dynamics as dropped.
      if (col.endsWith('Effector') && col !== 'BrushSizeEffector' && col !== 'BrushOpacityEffector') {
        const eff = parseEffector(val);
        if (eff && eff.active) add([col, describeEffector(eff), '-'], 'non');
      }
      continue;
    }
    const m = RMAP[col];
    if (!m) { counts.unmapped++; continue; }
    if (!m.k) { if (val) add([col, fmtVal(val), '-'], 'non'); continue; }
    const v = m.fn(val, p);
    s[m.k] = v;
    add([col, fmtVal(val), `${m.key} ← ${fmtVal(v)}`], m.f);
  }

  // Spacing: fixed % of size, or CSP's automatic narrow / normal / wide.
  if (p.BrushAutoIntervalType != null) {
    s.spacing = spacingFor(p.BrushInterval, p.BrushAutoIntervalType);
    add(['BrushInterval', `${fmtVal(p.BrushInterval)} (type ${p.BrushAutoIntervalType})`, `plotSpacing ← ${fmtVal(s.spacing)}`], 'dir');
  }
  if (p.BrushUseSpray) {
    s.jitter = clamp01(((p.BrushSpraySize || p.BrushSize || 1) / (p.BrushSize || 1)) * 0.5);
    add(['BrushSpraySize', fmtVal(p.BrushSpraySize ?? 0), `plotJitter ← ${fmtVal(s.jitter)}`], 'apx');
  }

  // Pressure dynamics from the decoded effectors.
  const sizeEff = parseEffector(p.BrushSizeEffector), opEff = parseEffector(p.BrushOpacityEffector);
  if (sizeEff) {
    s.pressureSize = sizeEff.pressure ? clamp01(1 - sizeEff.pressureMin) : 0;
    s.pressureSizeCurve = sizeEff.pressure ? sizeEff.pressureCurve : null;
    add(['BrushSizeEffector', describeEffector(sizeEff), `dynamicsPressureSize ← ${fmtVal(s.pressureSize)}`], 'dir');
    if (sizeEff.velocity) warnings.push('size by velocity not mapped');
  }
  if (opEff) {
    s.pressureOpacity = opEff.pressure ? clamp01(1 - opEff.pressureMin) : 0;
    s.pressureOpacityCurve = opEff.pressure ? opEff.pressureCurve : null;
    add(['BrushOpacityEffector', describeEffector(opEff), `dynamicsPressureOpacity ← ${fmtVal(s.pressureOpacity)}`], 'dir');
  }
  const rot = Math.trunc(p.BrushRotationEffector || 0);
  if (rot & 0x40) { s.followStroke = true; add(['BrushRotationEffector', String(rot), 'shapeRotation ← 1 (follows stroke)'], 'apx'); }
  if (rot & 0x80 && !(rot & 0x40)) { s.rotationJitter = 1; add(['BrushRotationEffector', String(rot), 'shapeScatter ← 1 (random)'], 'apx'); }
  if (p.BrushUseWaterColor) warnings.push('colour mixing / watercolour not mapped');
  if (p.CompositeMode) warnings.push(`blend mode ${p.CompositeMode} not mapped (uses Normal)`);
  if (p.UseDualBrush) warnings.push('dual brush has no Procreate equivalent (dropped)');
  return { settings: s, warnings, rows, counts };
}
