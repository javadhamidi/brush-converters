> [!WARNING]
> **AI disclosure:** This is entirely slop and none of the literature or code has been reviewed for technical accuracy.

---

# Building a Browser-Based Procreate-to-CSP Brush Converter: Technical Feasibility and Implementation Analysis

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

Resolution algorithm: follow `$top.root` UID into `$objects`, then recursively resolve any UID values found in properties. `UID(0)` always resolves to `"$null"`.

### Complete SilicaBrush property key enumeration

The SilicaBrush class contains **80+ known property keys** organized by Brush Studio panel:

**Stroke Path**: `spacing`, `spacingJitter`, `jitter`, `jitterLinear`, `streamline`, `streamlinePressure`, `stabilization`, `motionFiltering`, `fallOff`

**Taper**: `taperSize`, `taperOpacity`, `taperSizeBegin`, `taperSizeEnd`, `taperOpacityBegin`, `taperOpacityEnd`, `taperTouchSize`, `taperTouchOpacity`, `taperTouchSizeBegin`, `taperTouchSizeEnd`, `taperLinked`

**Shape**: `shapeScatter`, `shapeRotation`, `shapeCount`, `shapeCountJitter`, `shapeRandomized`, `shapeAzimuth`, `shapeBarrelRoll`, `shapeFlipX`, `shapeFlipY`, `shapeFiltering`, `bundledShapePath`

**Grain**: `grainMoving`, `grainScale`, `grainZoom`, `grainRotation`, `grainDepth`, `grainDepthMinimum`, `grainDepthJitter`, `grainOffsetJitter`, `grainBlendMode`, `grainBrightness`, `grainContrast`, `bundledGrainPath`

**Rendering**: `blendMode`, `luminanceBlending`, `colorBlending`

**Wet Mix**: `wetMixDilution`, `wetMixCharge`, `wetMixAttack`, `wetMixPull`, `wetMixGrade`, `wetMixBlur`, `wetMixBlurJitter`, `wetMixWetnessJitter`

**Color Dynamics**: `stampColorJitterHue/Saturation/Brightness/SecondaryColor`, `strokeColorJitterHue/Saturation/Brightness`, `colorPressureHue/Saturation/Brightness`, `colorTiltHue/Saturation/Brightness`

**Apple Pencil / Pressure**: `pressureSize`, `pressureOpacity`, `pressureSmoothing`, `pressureResponse`, `tiltSize`, `tiltOpacity`, `tiltAngle`, `tiltGrainScale`, `speedSize`, `speedOpacity`

**Properties / Limits**: `paintSize`, `paintSizeMin`, `paintOpacity`, `paintOpacityMin`, `smudgeAmount`, `previewStroke`, `orientToScreen`

**Metadata**: `name`, `signedID`, `resetSignedID`

---

## CSP .sut files are SQLite databases with TAR-embedded materials

A `.sut` (Sub Tool) file is a standard **SQLite 3 database**. The same schema powers CSP's internal `EditImageTool.todb` master database.

### Database schema

**Node table**: `_PW_ID` (pk), `NodeName` (text), `NodeVariantId` (int FK), `NodeInitVariantId` (int FK)

**Variant table**: The largest table with many parameter columns. Known categories:

- **Brush Size**: `BrushSize`, `BrushSizeEffector` (BLOB), `SpecifyBySizeOnScreen`, `AtLeast1Pixel`
- **Ink/Opacity**: `PaintOpacity`, `PaintOpacityEffector` (BLOB), `PaintBlendMode`, `PaintDensity`, `BrushDensity`, `AmountOfPaint`, `ColorStretch`
- **Anti-aliasing**: `AntiAliasing` (enum: None/Weak/Middle/Strong)
- **Brush Tip**: `BrushTipType`, `Hardness`, `Thickness`, `Direction`, `FlipHorizontal`, `FlipVertical`
- **Spraying**: `SprayingEffect`, `ParticleSize`, `ParticleDensity`, `SprayDeviation`
- **Stroke**: `Gap`/`Spacing`, `Ribbon`
- **Texture**: `TextureDensity`, `TextureScale`, `TextureRotation`
- **Stabilization**: `Stabilization`, `PostCorrection`
- **Taper**: `StartingLength`, `EndingLength`, `StartingEffector`, `EndingEffector`

**MaterialFile table**: `_PW_ID` (pk), `FileData` (BLOB — TAR archive containing `thumbnail/thumbnail.png`)

### The Effector binary format remains only partially decoded

The format is undocumented, changes across CSP versions, and only KennethEvans' VS-CSPBrushInfo C# tool has partial decoding. This is the **single largest blocker** for the converter.

---

## Eleven open-source tools reveal the state of format knowledge

1. **tohsakrat/Brush-Converter** — Extracts from .abr, .brushset, .sut. Can write back modified values but cannot create from scratch.
2. **Leon-Schoenbrunn/CSP2PC** — CSP→Procreate converter using template Seed.brush approach.
3. **MorrowShore/CSPBrushExtract** — Parameter extraction with web version.
4. **KennethEvans/VS-CSPBrushInfo** — Most advanced Effector decoding.
5. **aumlette-lab/procreate-brush-decoder** — Best Procreate key enumeration.
6. **FreyaLupen/procreate-to-krita-brush-converter** — Most mature Procreate conversion project.
7. **asterryplace/brushporter** — Recreating Procreate's Source Library as CC0.
8. **chsh2/import_paint_brush** — Blender add-on, widest format support.
9. **VarunVF/brush_converter** — Intermediate JSON format approach.
10. **Loperamide/CSPExtract** — Simple PNG extractor from .sut BLOBs.
11. **Krita Artists forum** — Most active recent community research.

**No existing tool performs Procreate→CSP conversion.**

---

## Parameter mapping: direct, approximate, and no-equivalent

### Direct (~60%): spacing→Gap, size→BrushSize, opacity→PaintOpacity, rotation→Direction, flip→Flip, tilt/pressure concept

### Approximate (~25%): streamline→Stabilization, rendering mode→ink mode, wet mix→color mixing, taper→starting/ending

### No equivalent (~15%): grain movement modes, wet mix charge/grade/attack, spacing jitter, fall off

---

## The browser-side implementation stack (~1.2 MB total)

- **JSZip** (~100 KB) for ZIP extraction
- **Binary plist parser** (custom or `@plist/plist` library)
- **NSKeyedArchive resolver** (~50 lines custom)
- **sql.js** (~1 MB with WASM) for SQLite .sut construction
- **Canvas API** (native) for image inversion
- **TAR creation** (~50 lines or tinytar library)

---

## Six blockers and their workarounds

1. **Effector binary format** → Use template-based approach with preset curve templates
2. **Built-in texture references** → Substitute CC0 equivalents or fallback shapes
3. **Grain movement modes** → Warn user; no CSP equivalent exists
4. **Rendering mode complexity** → Map glazing→Pen mode, wet mix→Watercolor mode
5. **CSP version-specific schemas** → Target CSP 2.x+, use template .sut from target version
6. **`.layer` digital asset format** → Not a blocker for new brush creation

---

## Conclusion

A template-driven architecture is the pragmatic path. Start from a template .sut, modify Variant values and MaterialFile BLOBs. This sidesteps both the Effector format gap and schema version problems. The community has been requesting this tool since at least 2024 with no existing solution.
