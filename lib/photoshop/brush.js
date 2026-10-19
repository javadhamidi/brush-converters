// Photoshop brush presets as a normalized settings object, the input of
// lib/krita/from-photoshop.js. Built from a 'brushPreset' action descriptor (key names as
// Photoshop writes them) or from a legacy v1/v2 record. DOM-free.

import { enumValue, num, pct } from './descriptor.js';
import { patternName } from './pattern.js';

// 'bVTy' in a 'brVr' dynamics block. Not every control is offered for every setting.
export const CONTROLS = ['off', 'fade', 'pressure', 'tilt', 'wheel', 'initial direction', 'direction', 'initial rotation', 'rotation'];

const TIP_KINDS = { computedBrush: 'computed', sampledBrush: 'sampled', dBrush: 'bristle', dTips: 'erodible' };

/** A 'brVr' block -> {control, steps, jitter, minimum}; jitter and minimum as fractions. */
export function dynamics(d) {
  if (!d) return { control: 'off', steps: 25, jitter: 0, minimum: 0 };
  return {
    control: CONTROLS[num(d.bVTy)] || 'off',
    steps: Math.max(Math.trunc(num(d.fStp, 25)), 1),
    jitter: pct(d.jitter),
    minimum: pct(d['Mnm ']),
  };
}

/** A tip with Photoshop's defaults; `mask` is a gray image (255 = paint) for sampled tips. */
export function sampleTip(mask, spacing = 0.25) {
  return {
    kind: 'sampled', size: mask ? Math.max(mask.width, mask.height) : 25, angle: 0, roundness: 1, hardness: 1,
    spacing, spacingOn: true, flipX: false, flipY: false, sampleId: null, mask,
  };
}

/** A 'Brsh' tip object; sampled tips get their mask from `samples` (by UUID). */
export function tipFromDescriptor(d, samples) {
  const kind = TIP_KINDS[d._class] || d._class || 'computed';
  const tip = {
    ...sampleTip(null, pct(d.Spcn, 0.25)),
    kind,
    size: num(d.Dmtr, 25),
    angle: num(d.Angl),
    roundness: pct(d.Rndn, 1),
    hardness: pct(d.Hrdn ?? d.dtipsHardness, 1),
    spacingOn: d.Intr !== false,
    flipX: !!d.flipX,
    flipY: !!d.flipY,
  };
  if (kind === 'sampled') {
    tip.sampleId = d.sampledData || null;
    tip.mask = samples.get(tip.sampleId) || null;
  }
  return tip;
}

/** A brush with only a tip, as legacy files and tips without presets give. */
export function plainBrush(name, tip) {
  return {
    name, group: null, tip, shape: null, scatter: null, texture: null, dual: null, transfer: null, color: null,
    tool: null, airbrush: false, wetEdges: false, noise: false, pose: false,
  };
}

function scatterSettings(d) {
  return {
    amount: dynamics(d.scatterDynamics),
    bothAxes: !!d.bothAxes,
    count: Math.max(Math.round(num(d['Cnt '], 1)), 1),
    countJitter: dynamics(d.countDynamics),
  };
}

function toolSettings(t) {
  if (!t) return null;
  return {
    kind: { MixB: 'mixer brush', SmTl: 'smudge tool' }[t._class] || 'brush',
    opacity: num(t.Opct, 100) / 100,
    flow: num(t.flow, 100) / 100,
    mode: enumValue(t['Md  ']) || 'Nrml',
    smoothing: !!t.smoothing && num(t.smoothingValue) > 0,
    pressureSize: !!t.usePressureOverridesSize,
    pressureOpacity: !!t.usePressureOverridesOpacity,
    opacityDynamics: t.opVr ? dynamics(t.opVr) : null,
    flowDynamics: t.prVr ? dynamics(t.prVr) : null,
  };
}

/** One 'brushPreset' descriptor. `samples`: Map(uuid -> mask), `patterns`: Map(uuid -> pattern). */
export function brushFromPreset(p, { samples, patterns, fallbackName }) {
  const brush = plainBrush((p['Nm  '] || '').trim() || fallbackName, tipFromDescriptor(p.Brsh || {}, samples));
  if (p.useTipDynamics) {
    brush.shape = {
      size: dynamics(p.szVr),
      minDiameter: pct(p.minimumDiameter),
      angle: dynamics(p.angleDynamics),
      roundness: dynamics(p.roundnessDynamics),
      minRoundness: pct(p.minimumRoundness),
      flipX: !!p.flipX,
      flipY: !!p.flipY,
      brushProjection: !!p.brushProjection,
    };
  }
  if (p.useScatter) brush.scatter = scatterSettings(p);
  if (p.useTexture && p.Txtr) {
    const id = p.Txtr.Idnt || null;
    const pattern = id && patterns.get(id);
    brush.texture = {
      id,
      name: patternName(p.Txtr['Nm  '] || (pattern && pattern.name) || 'pattern'),
      image: (pattern && pattern.image) || null,
      scale: pct(p.textureScale, 1),
      brightness: num(p.textureBrightness),
      contrast: num(p.textureContrast),
      depth: pct(p.textureDepth, 1),
      minDepth: pct(p.minimumDepth),
      depthDynamics: dynamics(p.textureDepthDynamics),
      invert: !!p.InvT,
      mode: enumValue(p.textureBlendMode) || 'Mltp',
      eachTip: !!p.TxtC,
    };
  }
  const db = p.dualBrush;
  if (db && db.useDualBrush && db.Brsh) {
    brush.dual = {
      tip: tipFromDescriptor(db.Brsh, samples),
      mode: enumValue(db.BlnM) || 'Mltp',
      flip: !!db.Flip,
      scatter: db.useScatter ? scatterSettings(db) : null,
    };
  }
  if (p.usePaintDynamics) {
    brush.transfer = { opacity: dynamics(p.opVr), flow: dynamics(p.prVr), wetness: dynamics(p.wtVr), mix: dynamics(p.mxVr) };
  }
  if (p.useColorDynamics) {
    brush.color = {
      foregroundBackground: dynamics(p.clVr),
      hue: pct(p['H   ']),
      saturation: pct(p.Strt),
      brightness: pct(p.Brgh),
      purity: pct(p.purity),
      perTip: p.colorDynamicsPerTip !== false, // the option (and key) arrived in CC; before, always per tip
    };
  }
  brush.tool = toolSettings(p.toolOptions);
  brush.airbrush = !!p['Rpt '];
  brush.wetEdges = !!p.Wtdg;
  brush.noise = !!p.Nose;
  brush.pose = !!p.useBrushPose;
  return brush;
}

/**
 * Brushes panel folders from a 'phry' hierarchy: a token list where 'Grup' {Nm, zuid} opens a
 * folder, 'preset' stands for the next preset and 'groupEnd' closes the folder. Returns one
 * folder path ('Inks / Fine', or null at the top level) per preset, or null when the tokens
 * don't add up to `count` presets.
 */
export function groupPaths(hierarchy, count) {
  const paths = [], stack = [];
  for (const t of hierarchy) {
    const cls = t && t._class;
    if (cls === 'Grup') {
      if (stack.length >= 32) return null;
      stack.push(String(t['Nm  '] ?? t.Nm ?? '').trim() || 'Folder');
    } else if (cls === 'groupEnd') {
      if (!stack.pop()) return null;
    } else if (cls === 'preset') {
      paths.push(stack.length ? stack.join(' / ') : null);
    } else {
      return null;
    }
  }
  return paths.length === count ? paths : null;
}
