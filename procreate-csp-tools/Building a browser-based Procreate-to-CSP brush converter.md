> [!WARNING]
> **AI disclosure:** This is entirely slop and none of the literature or code has been reviewed for technical accuracy.

---

# Building a browser-based Procreate-to-CSP brush converter

**A production-quality client-side converter from Procreate .brush to Clip Studio Paint .sut is architecturally feasible today**, using JSZip, a binary plist parser, sql.js (WebAssembly SQLite), and the Canvas API. The critical blocker is CSP's undocumented Effector binary format for pressure curves, which requires a template-based workaround. This report synthesizes reverse engineering from 11+ open-source projects, community research threads, and binary format analysis to provide every known technical detail for implementation.

---

## Procreate .brush files are ZIP archives wrapping an Apple binary plist

A `.brush` file is a standard **ZIP archive** (rename to `.zip` to inspect) with this internal structure:

```
brush_name.brush (ZIP)
├── Brush.archive        ← NSKeyedArchive binary plist (all brush settings)
├── Shape.png            ← Brush tip/stamp shape (grayscale)
├── Grain.png            ← Texture/grain pattern (grayscale)
├── Thumbnail.png        ← Stroke preview
├── Reset/               ← (optional) Factory reset archive
│   └── Brush.archive
├── AuthorPhoto.png      ← (optional, Procreate 5.0+)
└── AuthorSignature.png  ← (optional, Procreate 5.0+)
```

A `.brushset` is also a ZIP containing multiple brush folders plus a `brushset.plist` NSKeyedArchive manifest that defines ordering. Brushset files average **61 internal files** and range from 640 KB to 23 MB.

**Shape.png conventions**: Grayscale (single channel or grayscale+alpha), typically **512×512 or 1024×1024** pixels. **White = opaque/paint, black = transparent** — this is the opposite of CSP and must be inverted during conversion. Must be square for optimal results.

**Grain.png conventions**: Same grayscale format, commonly 512×512 through 2048×2048. **White = full texture, black = no texture**. Must tile seamlessly for "Moving" mode. Two modes control behavior: "Moving" (grain scrolls with the stroke) and "Texturized" (grain is fixed to the canvas like paper texture).

### The binary plist (bplist00) format in full detail

The `Brush.archive` file uses Apple's binary plist format. Parsing it requires understanding four sections:

**Header (8 bytes)**: Magic `bplist00` (hex: `62 70 6C 69 73 74 30 30`).

**Trailer (last 32 bytes of file)**: This is the parsing entry point.

| Offset from trailer start | Size | Field | Description |
|---|---|---|---|
| 0 | 5 | Padding | Always zeros |
| 5 | 1 | sortVersion | Unused for parsing |
| 6 | 1 | **offsetIntSize** | Bytes per offset table entry (1–8) |
| 7 | 1 | **objectRefSize** | Bytes per object reference in arrays/dicts (1–8) |
| 8 | 8 | **numObjects** | Total objects, big-endian uint64 |
| 16 | 8 | **topObjectIndex** | Root object index, usually 0 |
| 24 | 8 | **offsetTableOffset** | Byte position of offset table from file start |

In JavaScript, since values never exceed 2^32 in practice, read the lower 4 bytes of each 8-byte field:

```javascript
const trailerStart = buffer.byteLength - 32;
const dv = new DataView(buffer);
const offsetIntSize = dv.getUint8(trailerStart + 6);
const objectRefSize = dv.getUint8(trailerStart + 7);
const numObjects = dv.getUint32(trailerStart + 12);
const topObject = dv.getUint32(trailerStart + 20);
const offsetTableOffset = dv.getUint32(trailerStart + 28);
```

**Offset table**: Located at `offsetTableOffset`, containing `numObjects` entries of `offsetIntSize` bytes each. Each entry is a big-endian unsigned integer pointing to an object's byte position from file start.

**Object table**: Every object starts with a **marker byte** where the high nibble encodes type and the low nibble encodes size:

| High nibble | Type | Low nibble meaning |
|---|---|---|
| 0x0 | Singleton | 0x00=null, 0x08=false, 0x09=true, 0x0F=fill |
| 0x1 | Integer | 2^N byte count (0x10=1B, 0x11=2B, 0x12=4B, 0x13=8B) |
| 0x2 | Real | 2^N byte count (0x22=float32, 0x23=float64), big-endian IEEE 754 |
| 0x3 | Date | Always 0x33, 8-byte double (seconds since 2001-01-01 UTC) |
| 0x4 | Data | N = byte count (raw binary blob) |
| 0x5 | ASCII string | N = character count |
| 0x6 | Unicode string | N = character count (UTF-16BE, so 2N bytes) |
| **0x8** | **UID** | **N+1 = byte count** (critical difference: not 2^N) |
| 0xA | Array | N = element count |
| 0xC | Set | N = element count (same encoding as array) |
| 0xD | Dictionary | N = key-value pair count |

**Extended length encoding**: When the low nibble is `0xF`, the actual length follows as an embedded integer: read the next byte (must have high nibble 0x1), then read `2^(lowNibble)` bytes as the big-endian length value.

**UID type (0x8) — critical for NSKeyedArchive**: The low nibble `N` means the UID value occupies **N+1 bytes** (not 2^N). So `0x80` = 1-byte UID, `0x81` = 2-byte UID. The UID value is an index into the `$objects` array.

**Dictionary encoding**: After the marker, `count × objectRefSize` bytes of key references, followed by `count × objectRefSize` bytes of value references, paired positionally.

### NSKeyedArchive deserialization

The parsed binary plist yields a dictionary with exactly four keys:

```javascript
{
  "$archiver": "NSKeyedArchiver",
  "$version": 100000,
  "$top": { "root": UID(1) },
  "$objects": [
    "$null",                    // Index 0 — always the null sentinel
    { "$class": UID(N), "spacing": 0.05, "jitter": 0.0, ... },  // SilicaBrush
    // ... more objects (strings, arrays, class descriptors) ...
    { "$classname": "SilicaBrush", "$classes": ["SilicaBrush", "NSObject"] }
  ]
}
```

Resolution algorithm: follow `$top.root` UID into `$objects`, then recursively resolve any UID values found in properties. `UID(0)` always resolves to `"$null"`. For NSDictionary objects, keys live in `NS.keys` (UID → array of key strings) and values in `NS.objects` (UID → array of value objects). For NSArray, items are in `NS.objects`. Implement circular reference protection with a visited set.

```javascript
function resolveNSKeyedArchive(plistData) {
  const objects = plistData.$objects;
  const visited = new Set();
  function resolve(obj, idx) {
    if (obj && typeof obj === 'object' && 'UID' in obj) {
      if (visited.has(obj.UID)) return { $circularRef: obj.UID };
      visited.add(obj.UID);
      return resolve(objects[obj.UID], obj.UID);
    }
    if (obj === '$null') return null;
    if (Array.isArray(obj)) return obj.map((v, i) => resolve(v, i));
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key === '$class') continue;
        result[key] = resolve(value);
      }
      return result;
    }
    return obj;
  }
  return resolve({ UID: plistData.$top.root.UID });
}
```

### Complete SilicaBrush property key enumeration

The SilicaBrush class (`$classname: "SilicaBrush"`, `$classes: ["SilicaBrush", "NSObject"]`) contains **80+ known property keys** organized by Brush Studio panel. Values are stored inline (floats, ints, bools) or as UIDs referencing strings/arrays in `$objects`. The aumlette-lab/procreate-brush-decoder project maintains the most comprehensive JSON schema mapping raw keys to GUI settings with conversion formulas.

**Stroke Path** properties: `spacing` (float 0–1+, stamp gap as fraction of diameter), `spacingJitter` (float 0–1), `jitter` (float 0–1, lateral scatter), `jitterLinear` (float 0–1), `streamline` (float 0–1), `streamlinePressure` (float 0–1), `stabilization` (float 0–1, added in Procreate 5.2), `motionFiltering` (float 0–1, added 5.2), `fallOff` (float 0–1).

**Taper** properties: `taperSize`, `taperOpacity`, `taperSizeBegin`, `taperSizeEnd`, `taperOpacityBegin`, `taperOpacityEnd`, `taperTouchSize`, `taperTouchOpacity`, `taperTouchSizeBegin`, `taperTouchSizeEnd` (all float 0–1), `taperLinked` (bool).

**Shape** properties: `shapeScatter` (float), `shapeRotation` (float), `shapeCount` (int 1–16), `shapeCountJitter` (float), `shapeRandomized` (bool), `shapeAzimuth` (bool), `shapeBarrelRoll` (bool, Apple Pencil Pro), `shapeFlipX`/`shapeFlipY` (bool), `shapeFiltering` (int: 0=None, 1=Classic, 2=Improved), `bundledShapePath` (string UID or null).

**Grain** properties: `grainMoving` (bool: Moving vs Texturized), `grainScale` (float 0–2+), `grainZoom` (float 0–1), `grainRotation` (float), `grainDepth`/`grainDepthMinimum`/`grainDepthJitter` (floats 0–1), `grainOffsetJitter` (float), `grainBlendMode` (int enum), `grainBrightness`/`grainContrast` (float −1 to 1), `bundledGrainPath` (string UID or null).

**Rendering**: `blendMode` (int enum: rendering modes include Light Glaze, Uniform Glaze, Intense Glaze, Heavy Glaze, Uniform Blending, Intense Blending), `luminanceBlending` (bool), `colorBlending` (bool).

**Wet Mix** (added Procreate 5.0): `wetMixDilution`, `wetMixCharge`, `wetMixAttack`, `wetMixPull`, `wetMixGrade`, `wetMixBlur`, `wetMixBlurJitter`, `wetMixWetnessJitter` (all float 0–1).

**Color Dynamics** (added 5.0): `stampColorJitterHue`/`Saturation`/`Brightness`/`SecondaryColor`, `strokeColorJitterHue`/`Saturation`/`Brightness`, `colorPressureHue`/`Saturation`/`Brightness`, `colorTiltHue`/`Saturation`/`Brightness` (all float 0–1).

**Apple Pencil / Pressure**: `pressureSize`, `pressureOpacity`, `pressureSmoothing`, `pressureResponse`, `tiltSize`, `tiltOpacity`, `tiltAngle`, `tiltGrainScale`, `speedSize`, `speedOpacity` (all float 0–1).

**Properties / Limits**: `paintSize` (max size), `paintSizeMin`, `paintOpacity`, `paintOpacityMin`, `smudgeAmount`, `previewStroke` (bool), `orientToScreen` (bool).

**Metadata**: `name` (string UID), `signedID` (UUID string UID), `resetSignedID` (UUID string UID).

**Pressure curves** are stored as arrays of float control points within the `$objects` array, referenced by UIDs. The curve defines input→output mapping (0.0–1.0 on both axes) as interleaved x,y coordinate pairs representing Bézier control points.

**`bundledShapePath`/`bundledGrainPath`** reference built-in Procreate textures from the app's Source Library (e.g., `"Procreate/Shape Library/Circle Hard"`, `"Procreate/Grain Library/Fine Paper"`). When set to `$null` (UID(0)), the brush uses custom embedded Shape.png/Grain.png. **Built-in textures cannot be extracted from .brush files** — they exist only in Procreate's app bundle. The wakocima/brushporter project is recreating these as CC0 substitutes.

### Version changes across Procreate releases

**Procreate 5.0** (Dec 2019): Major Brush Studio overhaul — added Wet Mix panel, Color Dynamics, new rendering modes, "About this Brush" section, `signedID`/`resetSignedID` keys, AuthorPhoto.png/AuthorSignature.png in ZIP structure. **5.2**: Added Stabilization panel separate from StreamLine (`stabilization`, `motionFiltering` keys). **5.4+**: Added `spacingJitter`, `shapeCountJitter`. **5.5+**: Added `shapeBarrelRoll` for Apple Pencil Pro.

---

## CSP .sut files are SQLite databases with TAR-embedded materials

A `.sut` (Sub Tool) file is a standard **SQLite 3 database** — open it with any SQLite tool or `sql.js` in the browser. The same schema powers CSP's internal `EditImageTool.todb` master database.

### Database schema: three primary tables

**Node table** — stores brush identity and links to parameter records:

| Column | Type | Purpose |
|---|---|---|
| `_PW_ID` | INTEGER PRIMARY KEY | Universal key convention |
| `NodeName` | TEXT | Human-readable brush name |
| `NodeVariantId` | INTEGER | FK → Variant._PW_ID for current settings |
| `NodeInitVariantId` | INTEGER | FK → Variant._PW_ID for default/reset settings |

Brushes are identified by having **both NodeVariantId and NodeInitVariantId non-zero**. Other tools (erasers, selection tools) have zeros for these fields.

**Variant table** — the largest and most important table, containing **all brush parameter values**. Each row (identified by `_PW_ID`) represents a complete parameter set. The table has **many columns** — each a distinct parameter. Exact column names vary across CSP versions as features are added. Column types include INTEGER, REAL, TEXT, and BLOB (for Effectors and other binary data).

Known/inferred Variant column categories and representative names:

**Brush Size**: `BrushSize` (REAL, px), `BrushSizeEffector` (BLOB), `SpecifyBySizeOnScreen` (INTEGER bool), `AtLeast1Pixel` (INTEGER bool).

**Ink/Opacity**: `PaintOpacity` (REAL/INTEGER, 0–100), `PaintOpacityEffector` (BLOB), `PaintBlendMode` (INTEGER enum), `PaintDensity`/`BrushDensity` (REAL 0–100), `PaintDensityEffector` (BLOB), `MixGroundColor` (INTEGER bool), `AmountOfPaint` (REAL), `ColorStretch` (REAL).

**Anti-aliasing**: `AntiAliasing` (INTEGER enum: None/Weak/Middle/Strong).

**Brush Tip**: `BrushTipType` (INTEGER enum: Circle/Material), `Hardness` (REAL 0–100), `Thickness` (REAL), `ThicknessEffector` (BLOB), `Direction`/`BrushAngle` (REAL degrees), `DirectionEffector` (BLOB), `FlipHorizontal`/`FlipVertical` (INTEGER bool).

**Spraying**: `SprayingEffect` (INTEGER bool), `ParticleSize` (REAL), `ParticleDensity` (INTEGER), `SprayDeviation` (REAL).

**Stroke**: `Gap`/`Spacing` (REAL, percentage of brush size), `Ribbon` (INTEGER bool).

**Texture**: `TextureDensity` (REAL), `TextureScale` (REAL), `TextureRotation` (REAL), `ReverseDensity` (INTEGER bool), `EmphasizeDensity` (INTEGER bool).

**Stabilization**: `Stabilization` (INTEGER 0–100), `PostCorrection` (REAL), `MakeCornerPointed` (INTEGER bool).

**Taper**: `StartingLength` (REAL), `EndingLength` (REAL), `StartingEffector`/`EndingEffector` (BLOB).

**Color Jitter** (CSP 2.0+): Multiple columns for hue/saturation/value jitter.

All known parsers — tohsakrat's sut-parser.py, MorrowShore's CSPBrushExtract, KennethEvans' VS-CSPBrushInfo — **read columns dynamically** via `PRAGMA table_info(Variant)` rather than hardcoding names, because the schema evolves across CSP versions. The definitive column list for any given CSP version can only be obtained by querying an actual .sut file.

**MaterialFile table** — stores embedded binary materials:

| Column | Type | Purpose |
|---|---|---|
| `_PW_ID` | INTEGER PRIMARY KEY | Material identifier |
| `FileData` | BLOB | **TAR archive** containing brush tip images |

The `FileData` BLOB is a **standard TAR archive**. Extract with any TAR library. Internal structure:

```
thumbnail/
  thumbnail.png      ← The brush tip image (PNG)
```

Multiple MaterialFile rows may exist per brush (different tip shapes, textures). The sut-parser.py `replace_material()` method confirms the processing: grayscale pixel values become the alpha channel of an RGBA image with black RGB channels.

**CSP brush tip convention: dark = opaque, light = transparent.** This is the **inverse** of Procreate's white = opaque convention. From CSP documentation: "Areas closer to white will be more transparent, while areas closer to black will be more opaque." CSP internally stores tips as RGBA with black (0,0,0) RGB and the opacity information in the alpha channel.

### The Effector binary format remains only partially decoded

Effectors are the BLOB columns (names ending in `Effector`) storing pressure/tilt/velocity curves. **KennethEvans' VS-CSPBrushInfo (C#)** contains the most complete decoding, rendering visual curve graphs. Key caveats from that documentation:

- The format has been **"partially decoded"** through reverse engineering only
- **"The binary data format changes with the versions of Clip Studio Paint"**
- Interpretations are **"not based on information from Celsys and are not guaranteed to be correct"**
- The tool was last updated for CSP v1.8.8 (released v1.2.3, June 2021)

The inferred structure based on CSP's dynamics UI: a header containing version/type indicator and input source flags (pen pressure, tilt, velocity, random), followed by control point count, then x,y coordinate pairs (likely float32 or float64, normalized 0.0–1.0 on both axes). The minimum value slider and active input sources are encoded as flags. This is the **single largest blocker** for the converter.

### Relationships between .sut, .sutg, and EditImageTool.todb

`.sut` = single exported brush. `.sutg` = exported brush group (CSP 4.0+, multiple brushes in one file). Both are SQLite databases with the same schema. `EditImageTool.todb` is the master database at `Documents\CELSYS\CLIPStudioPaintVer1_5_0\Tool\` containing **all** tool configurations in a hierarchy: Tool → ToolGroup → SubTool. Exporting creates a .sut extract; importing merges back.

---

## Eleven open-source tools reveal the state of format knowledge

**tohsakrat/Brush-Converter** (Python, 204 lines): The most instructive for .sut creation. Its `sut-parser.py` dynamically reads all tables, extracts BLOBs as files, unpacks TAR archives, and can **write back** via `UPDATE {table} SET {column} = ? WHERE _PW_ID = ?`. It explicitly notes the `.layer` digital asset format inside MaterialFile BLOBs remains undecoded. However, for creating new brushes (vs. modifying existing ones), TAR archives with `thumbnail/thumbnail.png` are sufficient.

**Leon-Schoenbrunn/CSP2PC** (Python, MIT, v1.0.2 Aug 2025): The only tool converting **CSP → Procreate**. Uses a `Seed.brush` template file that gets its plist values modified. Maps spacing, jitter, taper, shape, wet mix, opacity, rotation, scatter, and flip. Reversing its mappings provides the Procreate → CSP direction. Documents CSP features with no Procreate equivalent: special texture effects, dynamic color blending, custom patterns, multi-brushes, pattern sequencing.

**MorrowShore/CSPBrushExtract** (Python, AGPL-3.0): Extracts brush tips and **decoded human-readable parameters** from .sut files. Available online at morrowshore.com/tool/csp-extractor/ (runs client-side). Also has a companion Procreate extractor. Contains the most current parameter decoding logic.

**KennethEvans/VS-CSPBrushInfo** (C#, v1.2.3): Windows app reading CSP brush databases with **partial Effector binary decoding** including curve visualizations. Can compare two brushes. The C# source in `CSP Brush Info/` directory contains the most detailed Effector parsing code available.

**aumlette-lab/procreate-brush-decoder** (TypeScript, MIT): Next.js web app with the **most comprehensive JSON schema** (`procreate-brush-decoder-vX.json`) mapping all raw plist keys to GUI values with formulas. Supports dual-brush comparison. Live at procreate-brush-decoder.vercel.app. The schema file is the single best reference for Procreate key enumeration.

**FreyaLupen/procreate-to-krita-brush-converter** (Python, GPLv3, KDE GitLab): Converts .brush, .abr, and .sut → Krita .kpp. Most actively maintained converter (updated through September 2025). Includes dump utilities for inspecting all formats. Uses Python's built-in `plistlib` for binary plist parsing.

**asterryplace/brushporter** (GPL-3.0): Semi-fork of FreyaLupen's scripts by wakocima, who authored a detailed research PDF ("prodata.pdf") documenting all Procreate brush.archive fields and is recreating Procreate's default Source Library under CC0.

**chsh2/import_paint_brush** (Python, GPL-3.0): Blender add-on (v0.4.0, Feb 2026, ~3K downloads) importing .abr, .gbr, .brushset, and .sut. Notes that .sut brushes may have multiple textures sampled randomly, and duo-color is unsupported.

**VarunVF/brush_converter** (Python, v0.3.0 Feb 2025): Uses an intermediate JSON format normalizing brush parameters across formats — useful reference for cross-format parameter normalization.

**Loperamide/CSPExtract** (Python, 76 lines): Simple PNG extractor scanning for PNG magic bytes (`\x89PNG`) within .sut BLOB data. Confirms MaterialFile contains embedded PNGs.

**Community research** on the Krita Artists forum (October 2024 – March 2026) has been the most active recent effort. FreyaLupen's conversion scripts support three input formats. A user (babyspacebear, November 2025) specifically asked about Procreate → CSP conversion, and FreyaLupen confirmed outputting .sut is not supported as "it would be significantly more difficult than reading them."

---

## Parameter mapping requires inversion, approximation, and graceful degradation

### Direct mappings

| Procreate | CSP | Notes |
|---|---|---|
| `spacing` | `Gap` | Both percentage of brush diameter; may need scale factor |
| `paintSize` / `paintSizeMin` | `BrushSize` / min size | Direct, different max ranges |
| `paintOpacity` | `PaintOpacity` | Both 0–100% range |
| `shapeRotation` | `Direction` / `BrushAngle` | Direct, degrees |
| `shapeScatter` | `SprayDeviation` / random translation | Percentage of scatter distance |
| `shapeFlipX` / `shapeFlipY` | `FlipHorizontal` / `FlipVertical` | Boolean toggles |
| `pressureSize` | `BrushSizeEffector` (pressure enabled) | Concept maps; encoding differs entirely |

### Approximation mappings requiring conversion logic

**Streamline → Stabilization**: Procreate's streamline (0–1) is a moving-average smoothing filter. CSP's Stabilization (0–100) is post-correction. Approximate: `CSP_Stabilization ≈ procreate_streamline × 100`. Not identical algorithms but similar user intent.

**Rendering mode → Ink mode**: Procreate's Glazing modes (Light/Uniform/Intense/Heavy Glaze) approximate CSP's Pen ink mode with Normal blend. Procreate's Blending modes approximate CSP's Watercolor ink mode. Best mapping: Glazing → CSP Pen mode (Normal), Wet Mix → CSP Watercolor mode.

**Wet Mix → Color mixing**: `wetMixDilution` ≈ CSP `PaintDensity` (inverted), `wetMixCharge` ≈ `AmountOfPaint`, `wetMixPull` ≈ `ColorStretch`. These are rough approximations — the blending algorithms differ fundamentally.

**Taper → Starting/Ending**: Procreate's pressure-based taper (`taperSizeBegin`/`taperSizeEnd`) maps to CSP's `StartingLength`/`EndingLength`, but Procreate uses percentage-based control while CSP uses pixel/speed-based lengths.

**Pressure curves**: Both use curve graphs with input→output mapping (0–1 on both axes). Procreate stores Bézier control points as float arrays in the NSKeyedArchive. CSP stores them as binary Effector BLOBs. The conceptual model is the same; the serialization is completely different.

### No-equivalent parameters requiring graceful fallback

| Procreate parameter | Why no CSP mapping |
|---|---|
| `grainMoving` (Rolling mode) | CSP textures never "roll" with stroke direction; unique to Procreate |
| `wetMixGrade` | Controls paint "drying" in Procreate's proprietary wet engine |
| `wetMixAttack` | Wet brush attack speed has no CSP equivalent |
| `fallOff` | Procreate-specific brush tip softness curve |
| `grainMovement` (Texturized mode) | Procreate-specific texture application mode |
| Color pressure dynamics | CSP has color jitter but different implementation |

### Texture conversion is mandatory

**Procreate brush tips (Shape.png): white = opaque.** **CSP brush tips: dark = opaque.** Every brush tip image must be **inverted** during conversion. Additionally, convert RGBA to grayscale if needed. The conversion in Canvas API:

```javascript
async function invertAndConvertForCSP(arrayBuffer) {
  const blob = new Blob([arrayBuffer], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    data[i] = data[i+1] = data[i+2] = 255 - gray; // Invert
    // Alpha: keep or set to 255
  }
  ctx.putImageData(imageData, 0, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
```

---

## The browser-side implementation stack totals roughly 1.2 MB

Every component needed runs entirely client-side with no server:

**JSZip (v3.10.1, ~100 KB)** for extracting .brush/.brushset ZIP archives:

```javascript
const zip = await JSZip.loadAsync(fileArrayBuffer);
const brushArchive = await zip.file("Brush.archive").async("arraybuffer");
const shapePng = await zip.file("Shape.png").async("arraybuffer");
const grainPng = await zip.file("Grain.png").async("arraybuffer");
```

**Binary plist parser**: Use `@plist/plist` by mat-sz (explicitly browser-compatible, uses ArrayBuffer not Node Buffer, supports binary/XML/text plists) or `@skgrush/bplist-and-nskeyedunarchiver` (TypeScript, supports both bplist parsing AND NSKeyedUnarchiver with custom class decoders — purpose-built for this use case). Alternative: `bplist-universal` or the manual implementation detailed in the binary plist section above.

**NSKeyedArchive resolution**: No production-ready browser library exists. The most practical approach is a custom resolver (~50 lines) handling SilicaBrush specifically, as shown in the resolution algorithm above. JSceneKit's NSKeyedUnarchiver (ES6) and `@suterma/nskeyedunarchiver-liveplayback` are alternatives but neither is battle-tested for Procreate's specific class structure.

**sql.js (~1 MB with WASM)** for creating the .sut SQLite database:

```javascript
const SQL = await initSqlJs({
  locateFile: filename => `https://sql.js.org/dist/${filename}`
});
const db = new SQL.Database();
db.run(`CREATE TABLE Node (
  _PW_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  NodeName TEXT, NodeVariantId INTEGER, NodeInitVariantId INTEGER
)`);
db.run(`CREATE TABLE Variant (_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, ...)`);
db.run(`CREATE TABLE MaterialFile (
  _PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, FileData BLOB
)`);
// Insert parameters and materials, then export:
const sutFile = db.export(); // Returns Uint8Array — this IS the .sut file
```

**tinytar (~5 KB)** for creating the MaterialFile TAR BLOB:

```javascript
import { tar } from 'tinytar';
const tarData = tar([
  { name: 'thumbnail/thumbnail.png', data: new Uint8Array(pngBuffer) }
]);
// Insert tarData as BLOB into MaterialFile.FileData
```

**Canvas API** (native) for image inversion and grayscale conversion. **Blob + URL.createObjectURL** (native) for triggering the download:

```javascript
const blob = new Blob([sutFile], { type: 'application/octet-stream' });
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'converted_brush.sut';
a.click();
URL.revokeObjectURL(a.href);
```

---

## Six blockers stand between prototype and production quality

**1. The Effector binary format gap (CRITICAL)**. Writing correct Effector BLOBs for pressure curves is the hardest unsolved problem. The format is undocumented by Celsys, changes across CSP versions, and only KennethEvans' C# code has partial decoding. **Workaround**: Use a **template-based approach** — start from a known-good .sut file (like CSP2PC's `Seed.brush` approach but in reverse), extract its Effector BLOBs as templates, and reuse them for converted brushes. A linear pressure curve Effector (the simplest case) can be captured from any default CSP brush. For more complex curves, offer a few preset Effector templates (linear, S-curve, concave, convex) rather than attempting exact Procreate curve reproduction.

**2. Built-in texture references can't be extracted**. When `bundledShapePath`/`bundledGrainPath` are non-null, the brush references textures embedded in Procreate's app bundle — **no image data exists in the .brush file**. The converter must detect this and either: (a) substitute from a bundled library of CC0 equivalents (wakocima's brushporter project is building this), (b) fall back to a simple circle/flat texture, or (c) prompt the user to supply a texture. Detection: check if `bundledShapePath !== null && Shape.png is missing or is a default placeholder`.

**3. Grain movement modes have no CSP equivalent**. Procreate's "Moving/Rolling" grain mode — where the texture scrolls with the stroke — is fundamentally impossible in CSP, which only supports static (canvas-fixed) or brush-follow textures. The converter should detect `grainMoving === true` and warn the user that the texture behavior will differ.

**4. Rendering mode complexity**. Procreate has 6 rendering modes (Light/Uniform/Intense/Heavy Glaze, Uniform/Intense Blending) that interact with the Wet Mix system. CSP's ink system (Pen, Airbrush, Watercolor, etc.) has overlapping but non-equivalent functionality. A reasonable default: map all Glazing modes to CSP Pen mode with Normal blend, map any brush with active Wet Mix to CSP Watercolor mode.

**5. CSP version-specific schema differences**. The Variant table schema has grown across CSP 1.x, 2.x, 3.x, and 5.x. Features like Color Jitter (v2.0+), velocity dynamics, and dual brush settings add new columns. **Workaround**: Target CSP 2.x+ as the minimum, use only widely-supported columns, and test against the latest version. The template approach helps here too — start from a .sut file exported from the target CSP version to inherit the correct schema.

**6. The `.layer` digital asset format**. tohsakrat's research found that CSP's "real" runtime textures are packaged in `.layer` format digital assets within the TAR archive, which remain undecoded. However, for **creating new brushes** (vs. extracting existing ones), this is not a blocker — CSP successfully imports .sut files containing only the `thumbnail/thumbnail.png` structure in the MaterialFile TAR.

---

## Conclusion: a template-driven architecture is the pragmatic path

The most viable architecture mirrors CSP2PC's approach but in reverse: **start from a template .sut file** exported from CSP, then programmatically modify its Variant table values and replace MaterialFile BLOBs with converted Procreate textures. This sidesteps both the Effector format gap and the schema version problem — the template carries correct binary structures and schema for its CSP version.

The conversion pipeline: (1) JSZip extracts the .brush ZIP, (2) a binary plist parser + NSKeyedArchive resolver extracts all SilicaBrush properties, (3) image processing inverts and converts Shape.png/Grain.png, (4) parameter mapping translates Procreate values to CSP equivalents, (5) sql.js opens a template .sut, updates Variant columns and MaterialFile BLOBs, (6) the modified database exports as the downloadable .sut file.

The community is converging on this problem from multiple directions — FreyaLupen's multi-format Krita scripts, Leon-Schoenbrunn's CSP2PC, MorrowShore's browser-based extractors — but **no existing tool performs Procreate→CSP conversion**. The November 2025 request on the Krita Artists forum specifically asking for this functionality went unanswered. Building it as a browser-side tool would fill a genuine gap that the digital art community has been requesting since at least 2024.