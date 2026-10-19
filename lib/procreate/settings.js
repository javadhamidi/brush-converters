// Procreate SilicaBrush keys <-> a small, normalised brush description ("settings") that
// the other converters map to and from. DOM-free.
//
// Key semantics, from real Brush.archive files (Procreate 4 and 5 use the same names):
//   paintSize      0..1 position of the size slider between minSize and maxSize
//   maxSize/minSize size limits (unit unknown; SIZE_UNIT px per 1.0 is an estimate)
//   plotSpacing    gap between dabs as a fraction of the dab size; plotJitter scatter
//   shapeRotation  0..1 how much the shape follows the stroke (1 = follows it)
//   shapeAngle     fixed angle (fraction of a turn); shapeScatter random rotation
//   shapeRandomise random start angle per stroke; oriented = "orient to screen"
//   dynamicsPressureSize / ...Opacity   0..1 amount of pressure on size / opacity
//   dynamicsSpeedSize / ...Opacity      -1..1 effect of stroke speed
//   bundledShapePath / bundledGrainPath images from Procreate's own library (not in the file)
// Older versions of this project wrote made-up "5.0+" names (spacing, pressureSize,
// minimumSize, ...) and paintSize in pixels; settingsFromArchive still reads those.

/** Pixels per 1.0 of Procreate's size scale. An estimate: brushes land within a few % of
 *  their usual sizes, but Procreate's size unit isn't documented. */
export const SIZE_UNIT = 100;
const BLANK_GRAIN = /blank/i;

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? Number(v) : d);
const first = (raw, keys, d) => {
  for (const k of keys) if (raw[k] != null && raw[k] !== '$null') return raw[k];
  return d;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Procreate curve dicts look like {points: ['{0.000000, 0.000000}', '{1.000000, 1.000000}']}. */
export function parseCurve(v) {
  const pts = v && Array.isArray(v.points) ? v.points : null;
  if (!pts) return null;
  const out = [];
  for (const p of pts) {
    const m = /\{\s*([-\d.e+]+)\s*,\s*([-\d.e+]+)\s*\}/i.exec(String(p));
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out.length >= 2 ? out.sort((a, b) => a[0] - b[0]) : null;
}

/** Flattened SilicaBrush dictionary -> settings. */
export function settingsFromArchive(raw, fallbackName = 'Brush') {
  const legacyPx = num(raw.paintSize, 0) > 1.5 && num(raw.maxSize, 1) <= 1; // our old writer: paintSize in px
  const legacy = legacyPx || raw.shapeAngle == null; // old writer: shapeRotation = angle, oriented = follow
  let size;
  if (legacyPx) size = num(raw.paintSize, 20);
  else if (raw.maxSize != null || raw.paintSize != null) {
    const lo = num(raw.minSize, 0), hi = num(raw.maxSize, 1);
    size = (lo + (hi - lo) * clamp(num(raw.paintSize, 0.5), 0, 1)) * SIZE_UNIT;
  } else size = num(first(raw, ['brushSize', 'maximumSize']), 20);

  // Pressure on size: real files have an amount; our old files had a 0/1 switch plus a minimum.
  let pressureSize = num(raw.dynamicsPressureSize, null);
  const oldMin = num(first(raw, ['minimumSize']), null);
  if (oldMin != null && (pressureSize === 1 || num(raw.pressureSize, 0) > 0)) pressureSize = clamp(1 - oldMin, 0, 1);
  pressureSize ??= num(raw.pressureSize, 0) > 0 ? 1 : 0;
  let pressureOpacity = num(raw.dynamicsPressureOpacity, null);
  const oldMinOp = num(raw.minimumOpacity, null);
  if (oldMinOp != null && (pressureOpacity === 1 || num(raw.pressureOpacity, 0) > 0)) pressureOpacity = clamp(1 - oldMinOp, 0, 1);
  pressureOpacity ??= num(raw.pressureOpacity, 0) > 0 ? 1 : 0;

  const shape = first(raw, ['bundledShapePath'], null);
  const grain = first(raw, ['bundledGrainPath'], null);
  return {
    name: String(first(raw, ['name', 'paintName'], fallbackName)).trim() || fallbackName,
    size: Math.max(size, 1),
    opacity: clamp(num(first(raw, ['paintOpacity', 'brushOpacity']), 1), 0, 1),
    flow: clamp(num(first(raw, ['dynamicsGlazedFlow', 'flow']), 1), 0, 1),
    spacing: Math.max(num(first(raw, ['plotSpacing', 'spacing']), 0.1), 0),
    jitter: Math.max(num(first(raw, ['plotJitter', 'jitter']), 0), 0),
    streamline: clamp(num(first(raw, ['plotSmoothing', 'streamline']), 0), 0, 1),
    pressureSize: clamp(pressureSize, 0, 1),
    pressureSizeCurve: parseCurve(raw.dynamicsPressureSizeCurve),
    pressureOpacity: clamp(pressureOpacity, 0, 1),
    pressureOpacityCurve: parseCurve(raw.dynamicsPressureOpacityCurve),
    speedSize: clamp(num(first(raw, ['dynamicsSpeedSize', 'speedSize']), 0), -1, 1),
    speedOpacity: clamp(num(first(raw, ['dynamicsSpeedOpacity', 'speedOpacity']), 0), -1, 1),
    tiltSize: num(raw.dynamicsTiltSize, 0),
    tiltOpacity: num(raw.dynamicsTiltOpacity, 0),
    sizeJitter: clamp(num(raw.dynamicsJitterSize, 0), 0, 1),
    opacityJitter: clamp(num(raw.dynamicsJitterOpacity, 0), 0, 1),
    angle: num(legacy ? raw.shapeRotation : raw.shapeAngle, 0) * 360,
    roundness: clamp(num(first(raw, ['shapeRoundness']), 1), 0.01, 1),
    followStroke: legacy ? !!raw.oriented : num(raw.shapeRotation, 0) >= 0.5,
    rotationJitter: clamp(num(raw.shapeScatter, 0), 0, 1),
    randomRotation: !!first(raw, ['shapeRandomise', 'shapeRandomizedRotation', 'shapeRandomized'], false),
    azimuth: !!raw.shapeAzimuth,
    flipX: !!first(raw, ['shapeFlipXJitter', 'shapeFlipX'], false),
    flipY: !!first(raw, ['shapeFlipYJitter', 'shapeFlipY'], false),
    shapeInverted: !!raw.shapeInverted,
    hasGrain: false, // set by whoever attaches a grain image
    grainDepth: clamp(num(first(raw, ['grainDepth']), 1), 0, 1),
    grainScale: num(first(raw, ['textureScale', 'grainScale']), 1) || 1,
    grainMoving: num(first(raw, ['textureMovement']), 0) > 0.5,
    grainInverted: !!raw.textureInverted,
    grainBrightness: clamp(num(raw.textureBrightness, 0), -1, 1),
    grainContrast: clamp(num(raw.textureContrast, 0), -1, 1),
    taperStart: clamp(num(raw.taperStartLength, 0), 0, 1),
    taperEnd: clamp(num(raw.taperEndLength, 0), 0, 1),
    blendMode: num(raw.blendMode, 0),
    wetMix: num(raw.dynamicsMix, 0) > 0 || num(raw.wetEdgesAmount, 0) > 0,
    colorJitter: ['dynamicsJitterHue', 'dynamicsJitterSaturation', 'dynamicsJitterLightness', 'dynamicsJitterDarkness',
      'dynamicsJitterStrokeHue', 'dynamicsJitterStrokeSaturation', 'dynamicsJitterStrokeLightness']
      .some((k) => num(raw[k], 0) > 0),
    stamp: !!raw.stamp,
    bundledShape: shape && shape !== '$null' ? String(shape) : null,
    bundledGrain: grain && grain !== '$null' && !BLANK_GRAIN.test(grain) ? String(grain) : null,
  };
}

/** What a settings object loses in Krita/CSP, as warnings. */
export function settingsWarnings(s) {
  const w = [];
  if (s.taperStart > 0.01 || s.taperEnd > 0.01) w.push('stroke taper not mapped');
  if (s.wetMix) w.push('wet mix / colour mixing not mapped');
  if (s.colorJitter) w.push('colour jitter not mapped');
  if (s.blendMode) w.push(`blend mode ${s.blendMode} not mapped (uses Normal)`);
  if (Math.abs(s.tiltSize) > 0.01 || Math.abs(s.tiltOpacity) > 0.01) w.push('tilt dynamics not mapped');
  if (s.azimuth) w.push('rotation by pen azimuth not mapped');
  if (s.grainMoving && s.hasGrain) w.push('moving grain approximated as a canvas texture');
  return w;
}

/** settings -> SilicaBrush keys (the real names), plus the alias names older versions of
 *  this project wrote, so files from either generation read back the same. */
export function archiveFromSettings(s, uuid) {
  const maxSize = Math.max(s.size / SIZE_UNIT, 0.01);
  const pc = {
    name: s.name,
    version: 2,
    // Size: the slider at the top of the range.
    paintSize: 1,
    maxSize,
    minSize: Math.min(0.005, maxSize),
    paintOpacity: s.opacity,
    maxOpacity: 1,
    minOpacity: 0,
    dynamicsGlazedFlow: s.flow,
    plotSpacing: s.spacing,
    plotSpacingVersion: 1,
    plotJitter: s.jitter,
    plotSmoothing: s.streamline,
    dynamicsPressureSize: s.pressureSize,
    dynamicsPressureOpacity: s.pressureOpacity,
    dynamicsSpeedSize: s.speedSize,
    dynamicsSpeedOpacity: s.speedOpacity,
    dynamicsJitterSize: s.sizeJitter,
    dynamicsJitterOpacity: s.opacityJitter,
    dynamicsTiltSize: 0,
    dynamicsTiltOpacity: 0,
    dynamicsFalloff: 0,
    dynamicsMix: 0,
    dynamicsLoad: 0,
    shapeAngle: (((s.angle % 360) + 360) % 360) / 360,
    shapeRoundness: s.roundness,
    shapeRotation: s.followStroke ? 1 : 0,
    shapeScatter: s.rotationJitter,
    shapeRandomise: s.randomRotation,
    shapeAzimuth: false,
    shapeFlipXJitter: s.flipX,
    shapeFlipYJitter: s.flipY,
    shapeInverted: false,
    shapeCount: 0,
    shapeFilter: true,
    shapeOrientation: 1,
    oriented: false,
    stamp: false,
    grainDepth: s.hasGrain ? s.grainDepth : 0,
    textureScale: s.grainScale,
    textureMovement: s.grainMoving ? 1 : 0,
    textureInverted: false,
    textureBrightness: s.grainBrightness,
    textureContrast: s.grainContrast,
    textureZoom: 1,
    textureFilter: true,
    textureOrientation: 1,
    textureApplication: 0,
    grainBlendMode: 1,
    grainOrientation: 1,
    taperStartLength: s.taperStart,
    taperEndLength: s.taperEnd,
    taperSize: 0,
    taperOpacity: 0,
    taperVersion: 1,
    blendMode: s.blendMode || 0,
    extendedBlend: 0,
    eraseSize: 0.5,
    eraseOpacity: 1,
    smudgeSize: 0.5,
    smudgeOpacity: 1,
    previewSize: 0.3,
    importedFromABR: false,
    // Pre-2024 names written by this project's first CSP -> Procreate converter.
    spacing: s.spacing,
    jitter: s.jitter,
    streamline: s.streamline,
    flow: s.flow,
    pressureSize: s.pressureSize > 0 ? 1 : 0,
    pressureOpacity: s.pressureOpacity > 0 ? 1 : 0,
    minimumSize: 1 - s.pressureSize,
    minimumOpacity: 1 - s.pressureOpacity,
    shapeRandomizedRotation: s.randomRotation ? 1 : 0,
    grainScale: s.grainScale,
    orientToScreen: false,
  };
  if (uuid) { pc.signedID = uuid; pc.resetSignedID = uuid; }
  return pc;
}

/** Defaults for settings built from scratch by the other converters. */
export function defaultSettings(name) {
  return settingsFromArchive({ name, paintSize: 0.5, maxSize: 0.4, minSize: 0, plotSpacing: 0.1, shapeAngle: 0 });
}
