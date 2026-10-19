// Map a Procreate brush (lib/procreate/read.js + decoded images) onto a Krita Pixel-brush
// preset, using the shared builders in ./preset.js. Returns the same shape as
// lib/krita/mapping.js convertBrush, so kppBytes / writeBundle work unchanged. DOM-free.

import { bundledShapeGuess, grainGray, shapeMask } from '../procreate/read.js';
import { settingsWarnings } from '../procreate/settings.js';
import { baseParams, buildTip, flat, fmt, LINEAR, setOption, slug, textureOption } from './preset.js';

/** Gray mask (255 = paint) -> RGBA image whose coverage() is that mask. */
function maskImage(mask) {
  const data = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i++) data[i * 4 + 3] = mask.data[i];
  return { width: mask.width, height: mask.height, data };
}

/** Gray (255 = white) -> opaque RGBA. */
function grayImage(gray) {
  const data = new Uint8ClampedArray(gray.width * gray.height * 4);
  for (let i = 0; i < gray.data.length; i++) data.set([gray.data[i], gray.data[i], gray.data[i], 255], i * 4);
  return { width: gray.width, height: gray.height, data };
}

/** Procreate's amount-style dynamics as a Krita sensor curve: 1 - amount + amount × curve. */
const amountCurve = (amount, curve) => (curve || LINEAR).map(([x, y]) => [x, 1 - amount + amount * y]);
const speedCurve = (s) => (s < 0 ? [[0, 1], [1, 1 + s]] : [[0, 1 - s], [1, 1]]);

/**
 * brush: {name, settings, shapeImage: RGBA | null, grainImage: RGBA | null}
 * Returns {name, params, dab, warnings, mapped}.
 */
export async function procreateToKrita(brush, pool, imaging, maxTip = 1024) {
  const s = brush.settings;
  const warnings = [...settingsWarnings({ ...s, hasGrain: !!brush.grainImage })];
  const mapped = [];
  const params = baseParams();
  const label = slug(brush.name);

  const size = Math.max(s.size, 1);
  const spacing = Math.min(Math.max(s.spacing, 0.02), 10);

  // Tip: Shape.png (white = paint), or a stand-in for Procreate's built-in shapes.
  const materials = [];
  let hardness = 1, roundness = s.roundness;
  if (brush.shapeImage) {
    materials.push({ name: 'shape', image: maskImage(shapeMask(brush.shapeImage, s.shapeInverted)) });
  } else {
    const guess = bundledShapeGuess(s.bundledShape);
    if (guess) { hardness = guess.hardness; roundness *= guess.ratio; }
    warnings.push(s.bundledShape
      ? `uses Procreate's built-in shape '${s.bundledShape}', which isn't in the file; ${guess ? 'approximated' : 'using a round tip'}`
      : 'no Shape.png; using a round tip');
  }
  const tip = await buildTip(materials, size, spacing, s.angle, hardness, 'shape', pool, label, false, maxTip, warnings, imaging);
  const files = tip.files;
  params.brush_definition = tip.xml;
  mapped.push(files.length ? 'tip image' : 'round tip');

  params.OpacityValue = fmt(s.opacity);
  params.FlowValue = fmt(s.flow);

  // Size dynamics.
  const sizeSensors = [];
  if (s.pressureSize > 0) sizeSensors.push(['pressure', amountCurve(s.pressureSize, s.pressureSizeCurve), null]);
  if (Math.abs(s.speedSize) > 0.01) sizeSensors.push(['speed', speedCurve(s.speedSize), null]);
  if (s.sizeJitter > 0.01) sizeSensors.push(['fuzzy', [[0, 1 - s.sizeJitter], [1, 1]], null]);
  if (sizeSensors.length) { setOption(params, 'Size', sizeSensors); mapped.push('size dynamics'); }

  // Opacity dynamics.
  const opSensors = [];
  if (s.pressureOpacity > 0) opSensors.push(['pressure', amountCurve(s.pressureOpacity, s.pressureOpacityCurve), null]);
  if (Math.abs(s.speedOpacity) > 0.01) opSensors.push(['speed', speedCurve(s.speedOpacity), null]);
  if (s.opacityJitter > 0.01) opSensors.push(['fuzzy', [[0, 1 - s.opacityJitter], [1, 1]], null]);
  if (opSensors.length) { setOption(params, 'Opacity', opSensors); mapped.push('opacity dynamics'); }

  // Rotation.
  let randomRotation = false;
  if (s.followStroke) {
    setOption(params, 'Rotation', [['drawingangle', LINEAR, {
      fanCornersStep: '90', fanCornersEnabled: '0', lockedAngleMode: '0', angleOffset: '0',
    }]]);
    mapped.push('rotation follows stroke');
  } else if (s.randomRotation || s.rotationJitter > 0.01) {
    randomRotation = true;
    setOption(params, 'Rotation', [[s.randomRotation ? 'fuzzystroke' : 'fuzzy', null, null]], s.randomRotation ? 1 : s.rotationJitter);
    mapped.push('random rotation');
  }
  if (s.followStroke && s.rotationJitter > 0.01) warnings.push('rotation jitter dropped (follows the stroke instead)');

  // Roundness -> ratio; jitter -> scatter; flips -> mirror.
  if (roundness < 0.999) {
    setOption(params, 'Ratio', [['pressure', flat(roundness), null]]);
    mapped.push(`roundness ${Math.round(roundness * 100)}%`);
  }
  if (s.jitter > 0.001) {
    setOption(params, 'Scatter', [['pressure', flat(1), null]], s.jitter);
    mapped.push('jitter (as scatter)');
  }
  if (s.flipX || s.flipY) {
    setOption(params, 'Mirror', [['fuzzy', null, null]]);
    params.HorizontalMirrorEnabled = s.flipX ? 'true' : 'false';
    params.VerticalMirrorEnabled = s.flipY ? 'true' : 'false';
    mapped.push('random flip');
  }

  // Grain -> texture. Procreate grain shows paint where it's white, as Krita's does uninverted.
  let pattern = null;
  if (brush.grainImage) {
    const gray = grainGray(brush.grainImage, s.grainInverted);
    const rgba = grayImage(gray);
    const { png, width, height } = await imaging.pattern(rgba);
    const filename = pool.add('patterns', `${label} grain.png`, png);
    textureOption(params, {
      filename, png, width, height,
      scale: s.grainScale * rgba.width / width,
      brightness: s.grainBrightness,
      contrast: 1 + s.grainContrast,
      strength: s.grainDepth,
      invert: false,
    });
    mapped.push('grain (as texture)');
    // The thumbnail renderer expects dark = paint.
    pattern = grayImage({ ...gray, data: gray.data.map((v) => 255 - v) });
  } else if (s.bundledGrain) {
    warnings.push(`uses Procreate's built-in grain '${s.bundledGrain}', which isn't in the file; no texture`);
  }

  params.requiredBrushFile = files[0] || '';
  params.requiredBrushFilesList = files.join(';');

  const dab = {
    mask: tip.mask, size, spacing, angle: s.angle,
    sizeCurve: (sizeSensors.find(([id]) => id === 'pressure') || [])[1] || null,
    opacity: s.opacity, flow: s.flow, followLine: s.followStroke, randomRotation,
    scatter: s.jitter, ratio: roundness, pattern, patternScale: s.grainScale,
  };
  return { name: brush.name, params, dab, warnings: [...new Set(warnings)], mapped };
}
