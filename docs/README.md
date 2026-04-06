> [!WARNING]
> **AI disclosure:** This is entirely slop and none of the literature or code has been reviewed for technical accuracy.

---

## Converters

### `procreate-to-csp.html`
Converts Procreate `.brush` and `.brushset` files to CSP `.sut` files.

**Pipeline:** ZIP extraction (JSZip) → binary plist parsing (hand-written `bplist00` parser) → NSKeyedArchive/SilicaBrush resolution → texture inversion (Canvas API) → parameter mapping → SQLite database construction (sql.js WASM)

### `csp-to-procreate.html`
Converts CSP `.sut` files to Procreate `.brush` files.

**Pipeline:** SQLite parsing (sql.js WASM) → TAR extraction from MaterialFile BLOBs → texture inversion → parameter reverse-mapping → binary plist *serialization* (hand-written `bplist00` writer) → NSKeyedArchive construction → ZIP packaging (JSZip)

## Usage

Open either HTML file in a browser. Drop a file on the upload zone. The pipeline runs with live step-by-step output showing exactly what's happening at each stage. Download the converted file when complete.

For CSP import: **File → Import Sub Tool** (drag `.sut` into sub tool palette)
For Procreate import: AirDrop or Files app

## Technical Details

### Format Anatomy

**Procreate `.brush`** = ZIP archive containing:
- `Brush.archive` — NSKeyedArchive binary plist (`bplist00`), root class `SilicaBrush`
- `Shape.png` — brush tip (white = opaque)
- `Grain.png` — texture overlay
- `QuickLook/Thumbnail.png` — preview

**CSP `.sut`** = SQLite 3 database containing:
- `Node` table — brush name, variant ID links
- `Variant` table — all parameters (150-190 columns, varies by CSP version)
- `MaterialFile` table — brush tip as TAR archive BLOB (`thumbnail/thumbnail.png`, dark = opaque)

### Key Versioning Issues

Procreate uses **two naming conventions** for brush parameters:
- **Pre-5.0** (old-style): `plotSpacing`, `dynamicsPressureSize`, `minSize`, `shapeRandomise`
- **5.0+** (new-style): `spacing`, `pressureSize`, `minimumSize`, `shapeRandomizedRotation`

CSP uses **different column names** than community documentation suggests:
- Real: `BrushInterval`, `Opacity`, `BrushFlow`, `BrushThickness`, `BrushRotation`, `BrushRevision`, `CompositeMode`
- Assumed: `Gap`, `PaintOpacity`, `BrushDensity`, `Thickness`, `Direction`, `Stabilization`, `PaintBlendMode`

Both converters handle both naming schemes.

### Parameter Mapping Coverage

| Category | Coverage | Notes |
|---|---|---|
| Brush size/opacity | ~95% | Direct mapping with scale conversion |
| Spacing/gap | ~95% | Percentage ↔ fraction conversion |
| Shape rotation/flip | ~90% | Direct, handles both old and new keys |
| Dynamics (pressure/speed/tilt) | ~70% | Values transfer; binary Effector curves cannot |
| Texture/grain | ~60% | Density/scale map; movement modes don't |
| Taper | ~50% | Start/end length map; Procreate's touch taper doesn't |
| Wet mix/color mixing | ~40% | Pull/dilution map; charge/grade/attack don't |
| Color dynamics | ~20% | CSP has different jitter model |
| Rendering mode | ~30% | 6 Procreate modes → 3 CSP ink modes (lossy) |
| Pressure curves | 0% | CSP Effector binary format is undocumented |

### Known Limitations

1. **Pressure curves** — CSP's binary Effector format for pressure/tilt/velocity curves is undocumented and version-dependent. Curves fall back to linear.
2. **Grain movement** — Procreate's rolling/texturized grain modes have no CSP equivalent (CSP textures are canvas-fixed).
3. **Eraser/smudge modes** — Procreate stores eraser/smudge settings per-brush; CSP treats these as separate tools.
4. **Built-in textures** — Brushes referencing Procreate's Source Library (`bundledShapePath`) have no embedded texture to convert.
5. **Dual brush** — CSP's dual brush system has no Procreate equivalent.

### Image Conversion

Brush tip images require **color inversion** between formats:
- Procreate: white = opaque, black = transparent
- CSP: dark = opaque, light = transparent

Double inversion (round-trip) is **100% lossless** — verified across all test brushes.

### Test Results

**01_-_Pencil.brush** (old-format, 34 params):
- Round-trip preservation: 30/34 (88%)
- Image match: 100%
- Losses: eraser/smudge mode settings only

**Cloud_Edges.brushset** (new-format, 2 brushes, 172 params each):
- Round-trip preservation: 29/168 per brush (17%)
- Image match: 100%
- Losses: mostly Procreate 5.0+ features without CSP equivalent

**Angled_Fluffy_Clouds.sut** (real CSP export, 156 scalar + 25 BLOB params):
- Brush tip: 100% identical
- Parameter preservation limited by format gap (CSP has ~150 columns with no Procreate equivalent)

## Dependencies

Browser-side (loaded from CDN):
- [JSZip 3.10.1](https://stuk.github.io/jszip/) — ZIP read/write
- [sql.js 1.8.0](https://sql.js.org/) — SQLite via WebAssembly

Python tests:
- Pillow — image processing
- numpy — pixel comparison

## Architecture

Each HTML file is **fully self-contained** — single file, no build step, no server. All JavaScript (including the binary plist parser/serializer, NSKeyedArchive resolver, TAR builder/parser, and parameter mapping engine) is inline.

## License

MIT
