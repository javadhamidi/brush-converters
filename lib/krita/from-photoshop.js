// Map a Photoshop brush (lib/photoshop/brush.js) onto a Krita Pixel-brush preset, using the
// shared builders in ./preset.js. Returns the same shape as from-procreate.js plus `tags`
// (the Brushes panel folder), so kppBytes / writeBundle work unchanged. DOM-free.

import { flattenGray } from '../pixels.js';
import { baseParams, buildTip, defaultParams, flat, fmt, LINEAR, MASK_OPTIONS, sensorXml, setOption, slug, textureOption } from './preset.js';

// Krita's texturing modes (KisTextureOptionData::TexturingMode, stable since Krita 5.0).
const TEXTURE_MODES = { Mltp: 0, blendSubtraction: 1, Sbtr: 1, Drkn: 4, Ovrl: 5, CDdg: 6, CBrn: 7, linearBurn: 9, hardMix: 10, Hght: 14, linearHeight: 15 };
// The blend modes Krita's masking brush offers (KisMaskingBrushCompositeOpFactory).
const MASKING_OPS = {
  Mltp: 'multiply', Drkn: 'darken', Ovrl: 'overlay', CDdg: 'dodge', CBrn: 'burn', linearBurn: 'linear_burn',
  hardMix: 'hard_mix_photoshop', blendSubtraction: 'subtract', Sbtr: 'subtract', Hght: 'height_photoshop',
  linearHeight: 'linear_height_photoshop',
};
// Painting blend modes -> Krita composite op ids (KoCompositeOpRegistry.h).
const BLEND_MODES = {
  Nrml: 'normal', Dslv: 'dissolve', Bhnd: 'behind', Clar: 'erase', Drkn: 'darken', Mltp: 'multiply', CBrn: 'burn',
  linearBurn: 'linear_burn', darkerColor: 'darker color', Lghn: 'lighten', Scrn: 'screen', CDdg: 'dodge',
  linearDodge: 'linear_dodge', lighterColor: 'lighter color', Ovrl: 'overlay', SftL: 'soft_light', HrdL: 'hard_light',
  vividLight: 'vivid_light', linearLight: 'linear light', pinLight: 'pin_light', hardMix: 'hard_mix_photoshop',
  Dfrn: 'diff', Xclu: 'exclusion', blendSubtraction: 'subtract', blendDivide: 'divide', 'H   ': 'hue',
  Strt: 'saturation', 'Clr ': 'color', Lmns: 'luminize',
};
// Photoshop dynamics controls -> Krita sensors. Tilt means the pen's lean (elevation) for most
// settings and the direction it leans for the angle; direction controls only exist for the angle.
const SENSORS = { fade: 'fade', pressure: 'pressure', tilt: 'declination', wheel: 'tangentialpressure', 'initial rotation': 'rotation', rotation: 'rotation' };
const ANGLE_SENSORS = { ...SENSORS, tilt: 'ascension' };
const DRAWING_ANGLE = { fanCornersEnabled: '0', fanCornersStep: '30', angleOffset: '0' };

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Gray mask (255 = paint) -> RGBA image whose coverage() is that mask. */
function maskImage(mask) {
  const data = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i++) data[i * 4 + 3] = mask.data[i];
  return { width: mask.width, height: mask.height, data };
}

function flipMask(mask, flipX, flipY) {
  if (!flipX && !flipY) return mask;
  const { width: w, height: h } = mask, data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = mask.data[(flipY ? h - 1 - y : y) * w + (flipX ? w - 1 - x : x)];
  }
  return { width: w, height: h, data };
}

/**
 * Krita sensors for a size-like setting: the Photoshop control as a curve from `min` (no
 * pressure, end of the fade, …) to full, and jitter as a random factor down to 1 - jitter.
 */
function sensors(dyn, min, what, warnings) {
  const out = [];
  const id = SENSORS[dyn.control];
  if (dyn.control === 'fade') out.push(['fade', [[0, 1], [1, min]], { periodic: '0', length: String(dyn.steps) }]);
  else if (id) out.push([id, [[0, min], [1, 1]], null]);
  else if (dyn.control !== 'off') warnings.push(`${what} control '${dyn.control}' not mapped`);
  if (dyn.jitter > 0.005) out.push(['fuzzy', [[0, Math.max(1 - Math.min(dyn.jitter, 1), min)], [1, 1]], null]);
  return out;
}

/**
 * Krita's rotation sensors for the angle dynamics. Krita adds a random sensor's -1..1 (scaled by
 * its curve) to a drawing-angle offset, so jitter is a curve centred on 0.5 at full strength.
 */
function angleSensors(dyn, warnings) {
  const out = [];
  if (dyn.control === 'direction' || dyn.control === 'initial direction') {
    out.push(['drawingangle', LINEAR, { ...DRAWING_ANGLE, lockedAngleMode: dyn.control === 'direction' ? '0' : '1' }]);
  } else if (dyn.control === 'fade') {
    out.push(['fade', LINEAR, { periodic: '0', length: String(dyn.steps) }]);
  } else if (ANGLE_SENSORS[dyn.control]) {
    out.push([ANGLE_SENSORS[dyn.control], LINEAR, null]);
  } else if (dyn.control !== 'off') {
    warnings.push(`angle control '${dyn.control}' not mapped`);
  }
  const j = Math.min(dyn.jitter, 1);
  if (j > 0.005) out.push(['fuzzy', [[0, 0.5 - j / 2], [1, 0.5 + j / 2]], null]);
  return out;
}

const spacingOf = (tip) => clamp(tip.spacing, 0.01, 10);

/** Tip materials for buildTip: the sample (flipped as Photoshop flips it), or none for a round tip. */
function tipMaterials(tip, what, warnings) {
  if (tip.kind === 'sampled' && tip.mask) return [{ name: 'tip', image: maskImage(flipMask(tip.mask, tip.flipX, tip.flipY)) }];
  if (tip.kind === 'sampled') warnings.push(`${what} image isn't in the file; using a round tip`);
  else if (tip.kind === 'bristle') warnings.push(`${what} is a bristle tip, approximated with a round tip`);
  else if (tip.kind === 'erodible') warnings.push(`${what} is an erodible / airbrush tip, approximated with a round tip`);
  else if (tip.kind !== 'computed') warnings.push(`${what} type '${tip.kind}' approximated with a round tip`);
  return [];
}

function scatterOption(params, scatter, prefix, warnings, what) {
  const amount = scatter.amount;
  const control = sensors({ ...amount, jitter: 0 }, 0, `${what}scatter`, warnings);
  setOption(params, 'Scatter', control.length ? control : [['pressure', flat(1), null]], amount.jitter, prefix);
  // Photoshop scatters across the stroke unless "Both Axes" is on; that's Krita's Y axis.
  params[`${prefix}Scattering/AxisX`] = scatter.bothAxes ? 'true' : 'false';
  params[`${prefix}Scattering/AxisY`] = 'true';
  if (scatter.count > 1) warnings.push(`${what}count ${scatter.count} imitated with tighter spacing`);
  if (scatter.countJitter.jitter > 0.005 || scatter.countJitter.control !== 'off') warnings.push(`${what}count jitter not mapped`);
}

async function textureParams(params, t, pool, imaging, warnings, mapped) {
  if (!t.image) {
    warnings.push(`uses the Photoshop pattern '${t.name}', which isn't in the file; no texture`);
    return null;
  }
  const { png, width, height } = await imaging.pattern(t.image);
  const filename = pool.add('patterns', `${t.name}.png`, png);
  if (!(t.mode in TEXTURE_MODES)) warnings.push(`texture mode '${t.mode}' approximated as multiply`);
  textureOption(params, {
    filename, png, width, height,
    scale: t.scale * t.image.width / width,
    brightness: clamp(t.brightness / 150, -1, 1),
    contrast: clamp(1 + t.contrast / 100, 0, 2),
    strength: t.depth,
    invert: t.invert, // both paint most where the pattern is light, unless inverted
    mode: TEXTURE_MODES[t.mode] ?? 0,
  });
  const depth = sensors(t.depthDynamics, t.minDepth, 'texture depth', warnings);
  if (depth.length) {
    params['PressureTexture/Strength/'] = 'true';
    params['Texture/Strength/Sensor'] = sensorXml(depth);
  }
  mapped.push(`texture '${t.name}'`);
  // For the thumbnail: dark = paint.
  const gray = flattenGray(t.image);
  const rgba = new Uint8ClampedArray(gray.data.length * 4);
  gray.data.forEach((v, i) => rgba.set(t.invert ? [v, v, v, 255] : [255 - v, 255 - v, 255 - v, 255], i * 4));
  return { width: gray.width, height: gray.height, data: rgba };
}

async function dualParams(params, d, size, pool, imaging, maxTip, label, warnings, mapped) {
  const prefix = 'MaskingBrush/Preset/';
  const count = d.scatter ? d.scatter.count : 1;
  const spacing = Math.max(spacingOf(d.tip) / count, 0.01);
  const { xml, files } = await buildTip(tipMaterials(d.tip, 'dual brush tip', warnings), d.tip.size, spacing, d.tip.angle,
    d.tip.hardness, 'dual brush tip', pool, `${label} dual`, false, maxTip, warnings, imaging);
  if (!(d.mode in MASKING_OPS)) warnings.push(`dual brush mode '${d.mode}' approximated as multiply`);
  Object.assign(params, defaultParams(prefix, MASK_OPTIONS), {
    'MaskingBrush/Enabled': 'true',
    'MaskingBrush/MaskingCompositeOp': MASKING_OPS[d.mode] || 'multiply',
    'MaskingBrush/MasterSizeCoeff': fmt(d.tip.size / size),
    'MaskingBrush/UseMasterSize': 'true',
    [`${prefix}brush_definition`]: xml,
    [`${prefix}requiredBrushFile`]: files[0] || '',
    [`${prefix}requiredBrushFilesList`]: files.join(';'),
    [`${prefix}OpacityValue`]: '1',
    [`${prefix}FlowValue`]: '1',
  });
  if (d.tip.roundness < 0.999) setOption(params, 'Ratio', [['pressure', flat(d.tip.roundness), null]], null, prefix);
  if (d.scatter) scatterOption(params, d.scatter, prefix, warnings, 'dual brush ');
  if (d.flip) {
    setOption(params, 'Mirror', [['fuzzy', null, null]], null, prefix);
    params[`${prefix}HorizontalMirrorEnabled`] = 'true';
    params[`${prefix}VerticalMirrorEnabled`] = 'true';
  }
  mapped.push('dual brush (as masking brush)');
  return files;
}

function colorParams(params, c, warnings, mapped) {
  const mix = sensors(c.foregroundBackground, 0, 'foreground/background', warnings);
  // Krita's Mix: 1 = foreground, 0 = background; Photoshop fades and jitters towards the background.
  if (mix.length) setOption(params, 'Mix', mix);
  const random = c.perTip ? 'fuzzy' : 'fuzzystroke';
  // Krita shifts hue by ±strength × 180° and saturation / value by ±strength.
  for (const [opt, amount] of [['h', c.hue], ['s', c.saturation], ['v', c.brightness]]) {
    if (amount > 0.005) setOption(params, opt, [[random, null, null]], Math.min(amount, 1));
  }
  if (mix.length || c.hue > 0.005 || c.saturation > 0.005 || c.brightness > 0.005) mapped.push('colour jitter');
  if (Math.abs(c.purity) > 0.005) warnings.push('colour purity not mapped');
}

function noteUnmapped(b, warnings) {
  if (b.tip.kind !== 'bristle' && !b.tip.spacingOn) warnings.push(`spacing is off in Photoshop (dabs follow pen speed); using ${Math.round(spacingOf(b.tip) * 100)}%`);
  if (b.shape && b.shape.brushProjection) warnings.push('brush projection not mapped');
  if (b.transfer && [b.transfer.wetness, b.transfer.mix].some((d) => d.control !== 'off' || d.jitter > 0.005)) warnings.push('wetness / mix jitter not mapped');
  if (b.tool && b.tool.kind !== 'brush') warnings.push(`${b.tool.kind} settings not mapped (painted as a normal brush)`);
  if (b.tool && b.tool.smoothing) warnings.push("smoothing is a tool option in Krita, so it isn't part of the preset");
  if (b.wetEdges) warnings.push("wet edges not supported in Krita's pixel brush");
  if (b.noise) warnings.push('noise not mapped');
  if (b.pose) warnings.push('brush pose not mapped');
}

/**
 * brush: a lib/photoshop/brush.js settings object.
 * Returns {name, params, dab, warnings, mapped, tags}.
 */
export async function photoshopToKrita(brush, pool, imaging, maxTip = 1024) {
  const warnings = [], mapped = [];
  const params = baseParams();
  const label = slug(brush.name);
  const { tip, shape, tool } = brush;
  const size = Math.max(tip.size, 1);

  // Tip and spacing. Photoshop's count (several dabs per step) is imitated with more steps.
  const count = brush.scatter ? brush.scatter.count : 1;
  const spacing = Math.max(spacingOf(tip) / count, 0.01);
  const built = await buildTip(tipMaterials(tip, 'tip', warnings), size, spacing, tip.angle, tip.hardness, 'tip', pool, label,
    false, maxTip, warnings, imaging);
  let files = built.files;
  params.brush_definition = built.xml;
  mapped.push(files.length ? 'tip image' : `round tip, ${Math.round(tip.hardness * 100)}% hard`);

  params.OpacityValue = fmt(tool ? tool.opacity : 1);
  params.FlowValue = fmt(tool ? tool.flow : 1);
  if (tool && tool.mode !== 'Nrml') {
    params.CompositeOp = BLEND_MODES[tool.mode] || 'normal';
    if (!BLEND_MODES[tool.mode]) warnings.push(`blend mode '${tool.mode}' not mapped (uses Normal)`);
  }

  // Shape dynamics.
  const sizeSensors = shape ? sensors(shape.size, shape.minDiameter, 'size', warnings) : [];
  if (tool && tool.pressureSize && !sizeSensors.some(([id]) => id === 'pressure')) sizeSensors.unshift(['pressure', LINEAR, null]);
  if (sizeSensors.length) { setOption(params, 'Size', sizeSensors); mapped.push('size dynamics'); }

  const rotation = shape ? angleSensors(shape.angle, warnings) : [];
  if (rotation.length) {
    setOption(params, 'Rotation', rotation, 1);
    mapped.push(rotation[0][0] === 'drawingangle' ? 'angle follows the stroke' : 'angle dynamics');
  }

  const roundness = clamp(tip.roundness, 0.01, 1);
  const ratio = shape ? sensors(shape.roundness, shape.minRoundness, 'roundness', warnings) : [];
  if (ratio.length) {
    setOption(params, 'Ratio', ratio, roundness);
    mapped.push('roundness dynamics');
  } else if (roundness < 0.999) {
    setOption(params, 'Ratio', [['pressure', flat(roundness), null]]);
    mapped.push(`roundness ${Math.round(roundness * 100)}%`);
  }
  if (shape && (shape.flipX || shape.flipY)) {
    setOption(params, 'Mirror', [['fuzzy', null, null]]);
    params.HorizontalMirrorEnabled = shape.flipX ? 'true' : 'false';
    params.VerticalMirrorEnabled = shape.flipY ? 'true' : 'false';
    mapped.push('random flip');
  }

  if (brush.scatter) { scatterOption(params, brush.scatter, '', warnings, ''); mapped.push('scattering'); }

  // Transfer: opacity and flow dynamics (CC keeps them in the tool options for some brushes).
  const transfer = brush.transfer || (tool && (tool.opacityDynamics || tool.flowDynamics)
    ? { opacity: tool.opacityDynamics || { control: 'off', jitter: 0 }, flow: tool.flowDynamics || { control: 'off', jitter: 0 } } : null);
  const opacitySensors = transfer ? sensors(transfer.opacity, transfer.opacity.minimum || 0, 'opacity', warnings) : [];
  if (tool && tool.pressureOpacity && !opacitySensors.some(([id]) => id === 'pressure')) opacitySensors.unshift(['pressure', LINEAR, null]);
  if (opacitySensors.length) { setOption(params, 'Opacity', opacitySensors); mapped.push('opacity dynamics'); }
  const flowSensors = transfer ? sensors(transfer.flow, transfer.flow.minimum || 0, 'flow', warnings) : [];
  if (flowSensors.length) { setOption(params, 'Flow', flowSensors); mapped.push('flow dynamics'); }

  let pattern = null;
  if (brush.texture) pattern = await textureParams(params, brush.texture, pool, imaging, warnings, mapped);
  if (brush.dual) files = files.concat(await dualParams(params, brush.dual, size, pool, imaging, maxTip, label, warnings, mapped));
  if (brush.color) colorParams(params, brush.color, warnings, mapped);
  if (brush.airbrush) { params['PaintOpSettings/isAirbrushing'] = 'true'; mapped.push('airbrush'); }
  noteUnmapped(brush, warnings);

  params.requiredBrushFile = files[0] || '';
  params.requiredBrushFilesList = files.join(';');

  const dab = {
    mask: built.mask, size, spacing, angle: tip.angle,
    sizeCurve: (sizeSensors.find(([id]) => id === 'pressure') || [])[1] || null,
    opacity: tool ? tool.opacity : 1, flow: tool ? tool.flow : 1,
    followLine: rotation.some(([id]) => id === 'drawingangle'),
    randomRotation: !!shape && shape.angle.jitter > 0.25,
    scatter: brush.scatter ? brush.scatter.amount.jitter : 0, ratio: roundness,
    pattern, patternScale: brush.texture ? brush.texture.scale : 1,
  };
  return { name: brush.name, params, dab, warnings: [...new Set(warnings)], mapped, tags: brush.group ? [brush.group] : [] };
}
