// Map a Krita preset (from lib/krita/read.js) onto Procreate brush settings
// (lib/procreate/settings.js). Also the first half of Krita -> CSP. DOM-free.

import { autoMask, curveAt, optionSensors } from '../krita/read.js';
import { defaultSettings } from './settings.js';

const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const range = (curve) => {
  const ys = curve.map((p) => p[1]);
  return [Math.min(...ys), Math.max(...ys)];
};
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

// Sensors with a Procreate counterpart, per option. Anything else becomes a warning.
const SENSOR_NAMES = {
  declination: 'pen tilt', ascension: 'pen direction', rotation: 'pen rotation', tangentialpressure: 'tangential pressure',
  distance: 'distance', time: 'time', fade: 'fade', perspective: 'perspective', drawingangle: 'stroke direction',
  fuzzystroke: 'random per stroke', fuzzy: 'random', speed: 'speed', pressure: 'pressure',
};

/**
 * preset: {name, engine, params, def, size, tips, tipLabel, texture, warnings}
 * Returns {settings, shape: mask (255 = paint), grain: gray (255 = paint) | null,
 *          warnings, mapped, rows: [[krita, value, procreate, fidelity]]}.
 */
export function kritaToSettings(preset) {
  const p = preset.params;
  const s = defaultSettings(preset.name);
  const warnings = [...preset.warnings];
  const mapped = [];
  const rows = [];
  const row = (k, v, to, f = 'dir') => rows.push([k, v, to, f]);
  const unmapped = (opt, sensors) => {
    for (const x of sensors) if (!['pressure', 'speed', 'fuzzy', 'fuzzystroke', 'drawingangle'].includes(x.id)) {
      warnings.push(`${opt.toLowerCase()} by ${SENSOR_NAMES[x.id] || x.id} not mapped`);
    }
  };

  if (preset.engine !== 'paintbrush') {
    warnings.push(`Krita's ${preset.engine} engine has no Procreate equivalent; only tip, size, opacity, spacing and dynamics carry over`);
  }

  // Size, opacity, flow.
  s.size = Math.max(preset.size, 1);
  row('size', `${fmtNum(preset.size)} px`, `maxSize = ${fmtNum(s.size / 100)} (≈ ${Math.round(s.size)} px)`, 'apx');
  s.opacity = clamp(num(p.OpacityValue, 1), 0, 1);
  s.flow = clamp(num(p.FlowValue, 1), 0, 1);
  row('OpacityValue', fmtNum(s.opacity), `paintOpacity = ${fmtNum(s.opacity)}`);
  row('FlowValue', fmtNum(s.flow), `dynamicsGlazedFlow = ${fmtNum(s.flow)}`, 'apx');

  // Spacing: fixed fraction of the size, or Krita's auto spacing (coefficient × √size px).
  const def = preset.def;
  if (def) {
    s.spacing = def.autoSpacing ? clamp(def.autoSpacingCoeff / Math.sqrt(Math.max(s.size, 1)), 0.01, 1) : clamp(def.spacing, 0, 10);
    row(def.autoSpacing ? `auto spacing ×${fmtNum(def.autoSpacingCoeff)}` : 'spacing', fmtNum(def.autoSpacing ? def.autoSpacingCoeff : def.spacing),
      `plotSpacing = ${fmtNum(s.spacing)}`, def.autoSpacing ? 'apx' : 'dir');
    s.angle = (def.angle * 180) / Math.PI;
    if (s.angle) row('tip angle', `${fmtNum(s.angle)}°`, `shapeAngle = ${fmtNum(s.angle / 360)}`);
  }
  if (optionSensors(p, 'Spacing')) warnings.push('spacing dynamics not mapped');

  // Size dynamics.
  const sizeSensors = optionSensors(p, 'Size');
  if (sizeSensors) {
    for (const x of sizeSensors) {
      const [lo] = range(x.curve);
      if (x.id === 'pressure') {
        s.pressureSize = clamp(1 - curveAt(x.curve, 0), 0, 1);
        row('Size: pressure', `curve from ${fmtNum(curveAt(x.curve, 0))}`, `dynamicsPressureSize = ${fmtNum(s.pressureSize)}`);
        mapped.push('size pressure');
      } else if (x.id === 'speed') {
        s.speedSize = clamp(curveAt(x.curve, 1) - curveAt(x.curve, 0), -1, 1);
        row('Size: speed', `${fmtNum(curveAt(x.curve, 0))} → ${fmtNum(curveAt(x.curve, 1))}`, `dynamicsSpeedSize = ${fmtNum(s.speedSize)}`, 'apx');
        mapped.push('size by speed');
      } else if (x.id === 'fuzzy' || x.id === 'fuzzystroke') {
        s.sizeJitter = clamp(1 - lo, 0, 1);
        row('Size: random', `from ${fmtNum(lo)}`, `dynamicsJitterSize = ${fmtNum(s.sizeJitter)}`, 'apx');
      }
    }
    unmapped('Size', sizeSensors);
  }

  // Opacity (and flow, which Procreate only has in glazed mode) dynamics.
  const opSensors = optionSensors(p, 'Opacity') || [];
  const flowSensors = optionSensors(p, 'Flow') || [];
  const opPressure = opSensors.find((x) => x.id === 'pressure') || flowSensors.find((x) => x.id === 'pressure');
  if (opPressure) {
    s.pressureOpacity = clamp(1 - curveAt(opPressure.curve, 0), 0, 1);
    const from = opSensors.includes(opPressure) ? 'Opacity' : 'Flow';
    row(`${from}: pressure`, `curve from ${fmtNum(curveAt(opPressure.curve, 0))}`, `dynamicsPressureOpacity = ${fmtNum(s.pressureOpacity)}`, from === 'Flow' ? 'apx' : 'dir');
    mapped.push(`${from.toLowerCase()} pressure`);
  }
  const opSpeed = opSensors.find((x) => x.id === 'speed');
  if (opSpeed) s.speedOpacity = clamp(curveAt(opSpeed.curve, 1) - curveAt(opSpeed.curve, 0), -1, 1);
  const opFuzzy = opSensors.find((x) => x.id === 'fuzzy' || x.id === 'fuzzystroke');
  if (opFuzzy) s.opacityJitter = clamp(1 - range(opFuzzy.curve)[0], 0, 1);
  unmapped('Opacity', opSensors);
  unmapped('Flow', flowSensors.filter((x) => x !== opPressure));

  // Rotation.
  const rot = optionSensors(p, 'Rotation');
  if (rot) {
    for (const x of rot) {
      if (x.id === 'drawingangle') { s.followStroke = true; row('Rotation: drawing angle', 'on', 'shapeRotation = 1 (follow stroke)'); mapped.push('rotation follows stroke'); }
      else if (x.id === 'fuzzystroke') { s.randomRotation = true; row('Rotation: random per stroke', 'on', 'shapeRandomise = true'); mapped.push('random rotation'); }
      else if (x.id === 'fuzzy') {
        const [lo, hi] = range(x.curve);
        s.rotationJitter = clamp((hi - lo || 1) * num(p.RotationValue, 1), 0, 1);
        row('Rotation: random', fmtNum(s.rotationJitter), `shapeScatter = ${fmtNum(s.rotationJitter)}`, 'apx');
        mapped.push('random rotation');
      }
    }
    unmapped('Rotation', rot);
  }

  // Ratio -> roundness (Krita's ratio squashes the tip like Procreate's roundness).
  const ratio = optionSensors(p, 'Ratio');
  if (ratio) {
    // Krita multiplies the value by each sensor's curve; a flat curve is a fixed ratio.
    s.roundness = clamp(ratio.reduce((v, x) => v * curveAt(x.curve, 0.5), num(p.RatioValue, 1)), 0.01, 1);
    if (ratio.some((x) => { const [lo, hi] = range(x.curve); return hi - lo > 0.01; })) warnings.push('ratio dynamics approximated as a fixed roundness');
    if (s.roundness < 1) { row('Ratio', fmtNum(s.roundness), `shapeRoundness = ${fmtNum(s.roundness)}`); mapped.push(`roundness ${Math.round(s.roundness * 100)}%`); }
  }

  // Scatter.
  if (optionSensors(p, 'Scatter')) {
    const amount = num(p.ScatterValue, 0);
    s.jitter = clamp(amount, 0, 1);
    if (amount > 1) warnings.push(`scatter ${fmtNum(amount)}× size clamped to Procreate's maximum jitter`);
    row('Scatter', fmtNum(amount), `plotJitter = ${fmtNum(s.jitter)}`, 'apx');
    mapped.push('scatter');
  }

  // Mirror (random flips).
  const mirror = optionSensors(p, 'Mirror');
  if (mirror) {
    s.flipX = p.HorizontalMirrorEnabled === 'true';
    s.flipY = p.VerticalMirrorEnabled === 'true';
    if (s.flipX || s.flipY) mapped.push('random flip');
  }

  // Options without a Procreate counterpart.
  for (const [opt, what] of [['Darken', 'darken'], ['Mix', 'colour mix'], ['h', 'hue'], ['s', 'saturation'], ['v', 'value'],
    ['Softness', 'softness'], ['Sharpness', 'pixel sharpness']]) {
    if (optionSensors(p, opt)) warnings.push(`${what} dynamics not mapped`);
  }
  if (p['MaskingBrush/Enabled'] === 'true') warnings.push('masking brush (dual tip) dropped');
  if (p['PaintOpSettings/isAirbrushing'] === 'true' || p['AirbrushOption/isAirbrushing'] === 'true') warnings.push('airbrush mode not mapped');
  const op = p.CompositeOp || 'normal';
  if (op === 'erase' || p.EraserMode === 'true') warnings.push('eraser preset: converted as a painting brush');
  else if (op !== 'normal') warnings.push(`blend mode '${op}' not mapped (uses Normal)`);
  if (preset.engine === 'colorsmudge') warnings.push('smudge / colour mixing not mapped');

  // Tip shape.
  let shape = preset.tips ? preset.tips.masks[0] : null;
  if (preset.tips && preset.tips.masks.length > 1) warnings.push(`animated tip has ${preset.tips.masks.length} images; Procreate gets the first`);
  if (!shape) shape = autoMask({ type: 'circle', id: 'default', ratio: 1, hfade: 0.95 }, 256);
  row('brush tip', preset.tipLabel, `Shape.png ${shape.width}×${shape.height}`, preset.tips ? 'dir' : 'apx');
  mapped.unshift(preset.tipLabel);

  // Texture -> grain. Krita's pattern paints where it's light; with Invert, where it's dark.
  let grain = null;
  if (preset.texture) {
    const t = preset.texture;
    grain = t.invert ? { ...t.gray, data: t.gray.data.map((v) => 255 - v) } : t.gray;
    s.hasGrain = true;
    s.grainDepth = clamp(t.strength, 0, 1);
    s.grainScale = clamp(t.scale, 0.05, 4);
    s.grainBrightness = clamp(t.brightness, -1, 1);
    s.grainContrast = clamp(t.contrast - 1, -1, 1);
    row('Texture', `'${t.name}'${t.invert ? ' (inverted)' : ''}`, `Grain.png, grainDepth = ${fmtNum(s.grainDepth)}, textureScale = ${fmtNum(s.grainScale)}`, 'apx');
    mapped.push(`texture '${t.name}'`);
    if (t.mode !== 0) warnings.push('texture subtract mode approximated as multiply');
  }

  return { settings: s, shape, grain, warnings: [...new Set(warnings)], mapped, rows };
}
