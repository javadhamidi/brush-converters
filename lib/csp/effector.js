// Decode CSP "effector" blobs (the dynamics attached to a brush parameter).
// Port of python/sut2krita/effector.py. Layout (big-endian int32):
//   [0] header size (44)   [1] available inputs mask
//   [2] enabled inputs: 0x10 pressure, 0x20 tilt, 0x40 velocity, 0x80 random
//   [3] pressure min %  [4] tilt min %  [5] velocity min %  [6] random min %
//   [8] byte offset of the pressure curve (0 = none)  [9] offset of a second (velocity) curve
// A curve block is [u32 12][u32 point count][u32 16] followed by (x, y) float64 pairs.

export const PRESSURE = 0x10, TILT = 0x20, VELOCITY = 0x40, RANDOM = 0x80;
export const LINEAR = [[0, 0], [1, 1]];

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

function readCurve(dv, offset) {
  if (!offset || offset + 12 > dv.byteLength) return null;
  const count = dv.getUint32(offset + 4, false), stride = dv.getUint32(offset + 8, false);
  if (stride !== 16 || count > 64) return null;
  const points = [];
  let pos = offset + 12;
  for (let k = 0; k < count && pos + 16 <= dv.byteLength; k++, pos += 16) {
    points.push([clamp01(dv.getFloat64(pos, false)), clamp01(dv.getFloat64(pos + 8, false))]);
  }
  if (points.length < 2) return null;
  return points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Returns an effector object, or null for a missing or unrecognised blob. */
export function parseEffector(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 44) return null;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const ints = Array.from({ length: 11 }, (_, i) => dv.getInt32(i * 4, false));
  if (ints[0] !== 44) return null;
  const flags = ints[2];
  return {
    flags,
    pressure: !!(flags & PRESSURE),
    tilt: !!(flags & TILT),
    velocity: !!(flags & VELOCITY),
    random: !!(flags & RANDOM),
    active: !!(flags & (PRESSURE | TILT | VELOCITY | RANDOM)),
    pressureMin: ints[3] / 100,
    tiltMin: ints[4] / 100,
    velocityMin: ints[5] / 100,
    randomMin: ints[6] / 100,
    pressureCurve: readCurve(dv, ints[8]) || LINEAR.map((p) => p.slice()),
    velocityCurve: readCurve(dv, ints[9]),
  };
}

export function describeEffector(eff) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  const parts = [];
  if (eff.pressure) {
    const pts = eff.pressureCurve.map(([x, y]) => `(${x.toFixed(2)},${y.toFixed(2)})`).join(' ');
    parts.push(`pressure min=${pct(eff.pressureMin)} curve=${pts}`);
  }
  if (eff.tilt) parts.push(`tilt min=${pct(eff.tiltMin)}`);
  if (eff.velocity) parts.push(`velocity min=${pct(eff.velocityMin)}`);
  if (eff.random) parts.push(`random min=${pct(eff.randomMin)}`);
  return parts.join('; ') || 'off';
}

/** Map a CSP curve plus its minimum onto a 0..1 output range. */
export function scaledCurve(points, minimum) {
  const m = clamp01(minimum);
  const pts = (points || LINEAR).map((p) => p.slice());
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]]);
  return pts.map(([x, y]) => [x, m + (1 - m) * y]);
}
