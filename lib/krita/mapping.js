// Map CSP brush settings onto a Krita Pixel brush ("paintbrush") preset.
// Port of python/sut2krita/mapping.py: keep the two in step (tests/js/parity.test.js).
//
// Image work is injected through `imaging` so this module stays DOM-free:
//   imaging.tipMask(image, maxTip) -> {mask: {width, height, data}, png} | null
//   imaging.pattern(image)         -> {png, width, height}
//   imaging.circleMask(hardness)   -> mask (thumbnail preview only)

import { LINEAR, parseEffector, scaledCurve } from '../csp/effector.js';
import { baseParams, buildTip, defaultParams, flat, fmt, MASK_OPTIONS, sensorXml, setOption, slug, textureOption } from './preset.js';

export { fmt, OPTIONS, ResourcePool, sensorXml, slug } from './preset.js';

// CSP BrushAutoIntervalType: 0 is "fixed" (BrushInterval = % of brush size); the others are
// automatic presets. Custom values only appear with type 0; line brushes use type 3.
const FIXED_SPACING = 0;
const AUTO_SPACING = { 1: 0.25, 2: 0.1, 3: 0.04 };
const ROT_PRESSURE = 0x10, ROT_TILT = 0x20, ROT_LINE = 0x40, ROT_RANDOM = 0x80;
const TEXTURE_MODES = { 0: 0, 1: 1 }; // CSP multiply / subtract -> Krita multiply / subtract

function effectorSensors(blob, what, warnings, scale = 1) {
  const eff = parseEffector(blob);
  if (!eff || !eff.active) return [];
  const sensors = [];
  if (eff.pressure) sensors.push(['pressure', scaledCurve(eff.pressureCurve, eff.pressureMin).map(([x, y]) => [x, y * scale]), null]);
  if (eff.velocity) sensors.push(['speed', scaledCurve(eff.velocityCurve || LINEAR, eff.velocityMin).map(([x, y]) => [x, y * scale]), null]);
  if (eff.random) sensors.push(['fuzzy', [[0, eff.randomMin * scale], [1, scale]], null]);
  if (eff.tilt) warnings.push(`tilt dynamics on ${what} not mapped`);
  return sensors;
}

export function spacingFor(interval, intervalType) {
  if (intervalType === FIXED_SPACING) return Math.min(Math.max((interval || 10) / 100, 0.01), 10);
  return AUTO_SPACING[intervalType] ?? 0.1;
}

async function textureParams(params, brush, pool, warnings, mapped, label, imaging) {
  const p = brush.params;
  const image = brush.texture.image;
  const { png, width: w, height: h } = await imaging.pattern(image);
  const filename = pool.add('patterns', `${label} ${brush.texture.name}.png`, png);
  const mode = p.TextureCompositeMode || 0;
  if (!(mode in TEXTURE_MODES)) warnings.push(`texture blend mode ${mode} approximated as multiply`);
  textureOption(params, {
    filename, png, width: w, height: h,
    scale: ((p.TextureScale2 || 100) / 100) * image.width / w,
    brightness: Math.min(Math.max(((p.TextureBrightness || 100) - 100) / 100, -1), 1),
    contrast: Math.min(Math.max((p.TextureContrast || 100) / 100, 0), 2),
    strength: (p.TextureDensity || 100) / 100,
    invert: !p.TextureReverseDensity,
    mode: TEXTURE_MODES[mode] ?? 0,
  });
  const sensors = effectorSensors(p.TextureDensityEffector, 'texture density', warnings);
  if (sensors.length) {
    params['PressureTexture/Strength/'] = 'true';
    params['Texture/Strength/Sensor'] = sensorXml(sensors);
  }
  mapped.push(`texture '${brush.texture.name}'`);
  return image;
}

async function dualParams(params, brush, size, pool, warnings, mapped, label, maxTip, imaging) {
  const p = brush.params;
  const prefix = 'MaskingBrush/Preset/';
  const dualSize = Number(p.DualSize || size);
  const spacing = spacingFor(p.DualInterval, p.DualAutoIntervalType);
  if (brush.dualTips.length > 1) warnings.push("dual brush uses several tips; Krita's masking brush gets them as an animated tip");
  const { xml, files } = await buildTip(brush.dualTips, dualSize, spacing, p.DualRotation || 0,
    (p.DualHardness || 100) / 100, 'dual brush tip', pool, `${label} dual`,
    [1, 3].includes(p.DualPatternOrderType), maxTip, warnings, imaging);
  Object.assign(params, defaultParams(prefix, MASK_OPTIONS), {
    'MaskingBrush/Enabled': 'true',
    'MaskingBrush/MaskingCompositeOp': 'multiply',
    'MaskingBrush/MasterSizeCoeff': fmt(dualSize / size),
    'MaskingBrush/UseMasterSize': p.SyncDualBrushSize ? 'true' : 'false',
    [`${prefix}brush_definition`]: xml,
    [`${prefix}requiredBrushFile`]: files[0] || '',
    [`${prefix}requiredBrushFilesList`]: files.join(';'),
    [`${prefix}OpacityValue`]: '1',
    [`${prefix}FlowValue`]: fmt((p.DualFlow || 100) / 100),
  });
  if (p.DualBrushCompositeMode) warnings.push(`dual brush blend mode ${p.DualBrushCompositeMode} approximated as multiply`);
  const sensors = effectorSensors(p.DualSizeEffector, 'dual brush size', warnings);
  if (sensors.length) setOption(params, 'Size', sensors, null, prefix);
  if (p.DualUseSpray) warnings.push('dual brush spray not mapped');
  mapped.push('dual brush (as masking brush)');
  return files;
}

function noteUnmapped(p, warnings) {
  const checks = [
    ['BrushUseWaterColor', 'color mixing / watercolor'],
    ['BrushUseWaterEdge', 'watercolor edge'],
    ['BrushUseIn', 'taper at stroke start'],
    ['BrushUseOut', 'taper at stroke end'],
    ['BrushRibbon', 'ribbon'],
    ['BrushChangePatternColor', 'brush tip color change'],
    ['BrushChangeStrokeColor', 'per-stroke color jitter'],
    ['BrushUseVectorEraser', 'vector eraser'],
  ];
  for (const [key, what] of checks) if (p[key]) warnings.push(`${what} not supported in Krita's pixel brush`);
  if (p.CompositeMode) warnings.push(`blend mode ${p.CompositeMode} not mapped (uses Normal)`);
  if (['BrushHueChange', 'BrushSaturationChange', 'BrushValueChange'].some((k) => p[k])) {
    warnings.push('color jitter (hue/saturation/value) not mapped');
  }
}

/**
 * Convert one CSP brush (from readSut) into a Krita preset.
 * Returns {name, params: {name: string | ['bytearray', string]}, dab, warnings, mapped}.
 */
export async function convertBrush(brush, pool, imaging, maxTip = 1024) {
  const p = brush.params;
  const warnings = [...brush.warnings];
  const mapped = [];
  const params = baseParams();
  const label = slug(brush.name);

  const size = Number(p.BrushSize || 10);
  if (p.BrushSizeUnit) warnings.push(`brush size unit ${p.BrushSizeUnit} assumed to be pixels`);

  // Spacing (and spray density, which Krita can only imitate with more dabs).
  let spacing = spacingFor(p.BrushInterval, p.BrushAutoIntervalType);
  let scatter = 0;
  if (p.BrushUseSpray) {
    const density = Math.max(Math.trunc(p.BrushSprayDensity || 1), 1);
    spacing = Math.max(spacing / density, 0.01);
    scatter = (Number(p.BrushSpraySize || size) / size) * 0.5;
    const sensors = effectorSensors(p.BrushSpraySizeEffector, 'spray size', warnings);
    setOption(params, 'Scatter', sensors.length ? sensors : [['pressure', flat(1), null]], scatter);
    mapped.push('spray (as scatter)');
    if (density > 1) warnings.push(`spray density ${density} imitated with tighter spacing`);
  }
  let sensors = effectorSensors(p.BrushIntervalEffector, 'spacing', warnings);
  if (sensors.length) setOption(params, 'Spacing', sensors);

  // Rotation and thickness.
  let angle = Number(p.BrushRotation || 0);
  if (p.BrushVerticalThicknes) angle += 90;
  const rotBits = Math.trunc(p.BrushRotationEffector || 0);
  const followLine = !!(rotBits & ROT_LINE);
  const randomRot = !!(rotBits & ROT_RANDOM) && !followLine;
  if (followLine) {
    setOption(params, 'Rotation', [['drawingangle', LINEAR, {
      fanCornersStep: '90', fanCornersEnabled: '0', lockedAngleMode: '0', angleOffset: '0',
    }]]);
    mapped.push('rotation follows stroke direction');
  } else if (randomRot) {
    setOption(params, 'Rotation', [['fuzzy', null, null]], (p.BrushRotationRandomScale || 100) / 100);
    mapped.push('random rotation');
  } else if (rotBits & ROT_PRESSURE) {
    setOption(params, 'Rotation', [['pressure', LINEAR, null]]);
    mapped.push('rotation by pressure');
  }
  if (rotBits & ROT_TILT) warnings.push('rotation by pen tilt not mapped');
  if (followLine && rotBits & ROT_RANDOM) warnings.push('random rotation dropped (stroke-direction rotation takes priority)');

  const thickness = Math.min(Math.max((p.BrushThickness || 100) / 100, 0.01), 1);
  if ((p.BrushThickness || 100) > 100) warnings.push(`thickness ${p.BrushThickness}% clamped to 100%`);
  sensors = effectorSensors(p.BrushThicknessEffector, 'thickness', warnings, thickness);
  if (sensors.length || thickness < 1) {
    setOption(params, 'Ratio', sensors.length ? sensors : [['pressure', flat(thickness), null]]);
    mapped.push(`thickness ${Math.round(thickness * 100)}%`);
  }

  // Tip.
  const tip = await buildTip(brush.tips, size, spacing, angle, (p.BrushHardness || 100) / 100, 'tip', pool,
    label, [1, 3].includes(p.BrushPatternOrderType), maxTip, warnings, imaging);
  let files = tip.files;
  mapped.push(files.length ? `${brush.tips.length} tip image(s)` : 'round tip');
  params.brush_definition = tip.xml;

  // Opacity, flow, size dynamics.
  const opacity = (p.Opacity ?? 100) / 100;
  const flow = (p.BrushFlow ?? 100) / 100;
  params.OpacityValue = fmt(opacity);
  params.FlowValue = fmt(flow);
  const sizeSensors = effectorSensors(p.BrushSizeEffector, 'size', warnings);
  if (sizeSensors.length) { setOption(params, 'Size', sizeSensors); mapped.push('size dynamics'); }
  sensors = effectorSensors(p.BrushOpacityEffector, 'opacity', warnings);
  if (sensors.length) { setOption(params, 'Opacity', sensors); mapped.push('opacity dynamics'); }
  sensors = effectorSensors(p.BrushFlowEffector, 'density', warnings);
  if (sensors.length) { setOption(params, 'Flow', sensors); mapped.push('density dynamics'); }

  if (p.AntiAlias === 0) {
    setOption(params, 'Sharpness', [['pressure', flat(1), null]]);
    mapped.push('no anti-aliasing (pixel sharpness)');
  }

  let pattern = null;
  if (brush.texture) pattern = await textureParams(params, brush, pool, warnings, mapped, label, imaging);
  if (p.UseDualBrush) {
    if (p.DualUsePatternImage && !brush.dualTips.length) warnings.push('dual brush tip missing; dual brush skipped');
    else files = files.concat(await dualParams(params, brush, size, pool, warnings, mapped, label, maxTip, imaging));
  }
  params.requiredBrushFile = files[0] || '';
  params.requiredBrushFilesList = files.join(';');

  noteUnmapped(p, warnings);
  const sizeCurve = (sizeSensors.find(([sid]) => sid === 'pressure') || [])[1] || null;
  const dab = {
    mask: tip.mask, size, spacing, angle, sizeCurve, opacity, flow, followLine,
    randomRotation: randomRot, scatter, ratio: thickness, pattern,
    patternScale: (p.TextureScale2 || 100) / 100,
  };
  return { name: brush.name, params, dab, warnings, mapped };
}
