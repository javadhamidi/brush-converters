// Write a minimal Clip Studio Paint sub tool (.sut, SQLite) from Procreate-style brush
// settings (lib/procreate/settings.js). Experimental: CSP keeps tips in encrypted .layer
// files we can read but not write, so the tip goes in as the material's thumbnail.png,
// and the Variant table mixes real CSP columns with guessed ones. DOM-free (sql.js passed in).

import { grayPng } from '../png.js';
import { buildTar } from '../tar.js';

// [column, SQL type, value from settings]
const COLUMNS = [
  ['BrushSize', 'REAL', (s) => s.size],
  ['BrushSizeMin', 'REAL', (s) => s.size * (1 - s.pressureSize)],
  ['BrushSizeMax', 'REAL', (s) => s.size],
  ['PaintOpacity', 'REAL', (s) => s.opacity * 100],
  ['PaintOpacityMin', 'REAL', (s) => (1 - s.pressureOpacity) * 100],
  ['PaintOpacityMax', 'REAL', () => 100],
  ['BrushDensity', 'REAL', (s) => s.flow * 100],
  ['Gap', 'REAL', (s) => s.spacing * 100],
  ['Stabilization', 'INTEGER', (s) => Math.min(100, Math.round(s.streamline * 50))],
  ['Direction', 'REAL', (s) => s.angle],
  ['Thickness', 'REAL', (s) => s.roundness * 100],
  ['DirectionRange', 'REAL', (s) => (s.randomRotation || s.rotationJitter > 0.01 ? 360 : 0)],
  ['FlipHorizontal', 'INTEGER', (s) => (s.flipX ? 1 : 0)],
  ['FlipVertical', 'INTEGER', (s) => (s.flipY ? 1 : 0)],
  ['ColorStretch', 'REAL', () => 0],
  ['AmountOfPaint', 'REAL', () => 100],
  ['TextureDensity', 'REAL', (s) => (s.hasGrain ? s.grainDepth * 100 : 0)],
  ['TextureScale', 'REAL', (s) => s.grainScale * 100],
  ['SprayDeviation', 'REAL', (s) => s.jitter * 100],
  ['SprayingEffect', 'INTEGER', (s) => (s.jitter > 0.01 ? 1 : 0)],
  ['ParticleDensity', 'INTEGER', () => 1],
  ['PaintBlendMode', 'INTEGER', (s) => s.blendMode || 0],
  ['AntiAliasing', 'INTEGER', () => 2],
  ['StartingLength', 'REAL', (s) => s.taperStart * 100],
  ['EndingLength', 'REAL', (s) => s.taperEnd * 100],
  ['WatercolorEdge', 'REAL', () => 0],
  ['Hardness', 'REAL', () => 80],
  ['BrushTipType', 'INTEGER', () => 1],
  ['DynPressureSize', 'REAL', (s) => s.pressureSize],
  ['DynPressureOpacity', 'REAL', (s) => s.pressureOpacity],
  ['DynSpeedSize', 'REAL', (s) => s.speedSize],
  ['DynSpeedOpacity', 'REAL', (s) => s.speedOpacity],
  ['DynFalloff', 'REAL', () => 0],
  ['DynMix', 'REAL', () => 0],
  ['DynGlaze', 'INTEGER', () => 0],
  ['TaperSize', 'REAL', () => 1],
  ['TaperOpacity', 'REAL', () => 1],
  ['TexMovement', 'REAL', (s) => (s.grainMoving ? 1 : 0)],
  ['TexZoom', 'REAL', () => 0],
  ['TexRotation', 'REAL', () => 0],
  ['TexFilter', 'INTEGER', () => 0],
  ['BrushSizeMinRatio', 'REAL', (s) => 1 - s.pressureSize],
  ['BrushSizeMaxRatio', 'REAL', () => 1],
  ['Oriented', 'INTEGER', (s) => (s.followStroke ? 1 : 0)],
  ['Stamp', 'INTEGER', () => 0],
  // Real CSP column names.
  ['BrushInterval', 'REAL', (s) => s.spacing * 100],
  ['Opacity', 'REAL', (s) => s.opacity * 100],
  ['BrushFlow', 'REAL', (s) => s.flow * 100],
  ['BrushThickness', 'REAL', (s) => s.roundness * 100],
  ['BrushRotation', 'REAL', (s) => s.angle],
  ['BrushHardness', 'REAL', () => 80],
  ['BrushRevision', 'INTEGER', (s) => Math.min(20, Math.round(s.streamline * 20))],
  ['CompositeMode', 'INTEGER', (s) => s.blendMode || 0],
  ['AntiAlias', 'INTEGER', () => 2],
  ['BrushInLength', 'REAL', (s) => s.taperStart * 100],
  ['BrushOutLength', 'REAL', (s) => s.taperEnd * 100],
  ['BrushInRatio', 'REAL', () => 0],
  ['BrushOutRatio', 'REAL', () => 0],
  ['BrushMixColor', 'REAL', () => 0],
  ['BrushMixAlpha', 'REAL', () => 100],
  ['BrushSprayDensity', 'INTEGER', () => 1],
  ['BrushUsePatternImage', 'INTEGER', () => 1],
  ['SourceName', 'TEXT', (s) => s.name],
];

/** The Variant columns this writer fills, with their values, for display. */
export function sutColumns(settings) {
  return COLUMNS.map(([col, , fn]) => [col, fn(settings)]);
}

/**
 * settings: lib/procreate/settings.js object; tip: gray mask (255 = paint).
 * Returns the .sut file bytes.
 */
export async function writeSut(SQL, settings, tip) {
  const db = new SQL.Database();
  try {
    db.run('CREATE TABLE Node(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT,NodeName TEXT,NodeVariantId INTEGER,NodeInitVariantId INTEGER)');
    db.run(`CREATE TABLE Variant(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT,VariantId INTEGER,${COLUMNS.map(([c, t]) => `${c} ${t}`).join(',')})`);
    db.run('CREATE TABLE MaterialFile(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT,FileData BLOB)');
    const values = COLUMNS.map(([, , fn]) => fn(settings));
    const insert = `INSERT INTO Variant(_PW_ID,VariantId,${COLUMNS.map(([c]) => c).join(',')}) VALUES(?,?,${COLUMNS.map(() => '?').join(',')})`;
    db.run(insert, [1, 1, ...values]); // current settings
    db.run(insert, [2, 2, ...values]); // "initial" settings CSP resets to
    db.run('INSERT INTO Node VALUES(1,?,1,2)', [settings.name]);
    // CSP draws with dark ink: store the tip as dark-on-white.
    const inverted = { ...tip, data: tip.data.map((v) => 255 - v) };
    const tar = buildTar([{ name: 'thumbnail/thumbnail.png', data: await grayPng(inverted) }]);
    db.run('INSERT INTO MaterialFile VALUES(1,?)', [tar]);
    return new Uint8Array(db.export());
  } finally {
    db.close();
  }
}
