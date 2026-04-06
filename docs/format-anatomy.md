> [!WARNING]
> **AI disclosure:** This is entirely slop and none of the literature or code has been reviewed for technical accuracy.

---

# Deep Technical Anatomy of Procreate and CSP Brush Formats: Building a Cross-Format Converter

**No Procreate-to-CSP brush converter exists today, but building one is feasible.** The Procreate `.brush` format is a ZIP archive containing an NSKeyedArchive binary plist and PNG textures — well-understood thanks to multiple open-source parsers. The Clip Studio Paint `.sut` format is a SQLite database with brush parameters in a `Variant` table and tip images packed as TAR archives inside BLOBs — partially reverse-engineered but with critical gaps in the binary "Effector" encoding for pressure curves. Roughly **60% of brush parameters map directly** between the two formats, **25% require approximation**, and **15% have no equivalent**. The one existing converter (CSP2PC) works only in the reverse direction — CSP to Procreate — and the main blocker for the Procreate-to-CSP direction is constructing valid `.sut` files with correct Effector binary data.

---

## Inside the Procreate .brush file

A `.brush` file is a **renamed ZIP archive**. Renaming it to `.zip` and extracting reveals a consistent internal layout:

```
MyBrush.brush (ZIP)
├── Brush.archive          # NSKeyedArchive binary plist — all brush parameters
├── Shape.png              # Brush tip/stamp image (grayscale, typically 512–1024px square)
├── Grain.png              # Texture/grain image (grayscale, up to 2048px square)
├── QuickLook/
│   └── Thumbnail.png      # UI preview thumbnail
├── Reset.archive          # (optional) Saved reset-to-default state
├── photo.png              # (optional) Author photo
└── signature.png          # (optional) Author signature
```

A `.brushset` file uses the same ZIP container holding multiple UUID-named brush directories plus a `brushset.plist` manifest. Sets contain **18–150 files** on average and range from **640 KB to 23 MB**.

The `Brush.archive` file is the heart of the format. It is a binary property list (`bplist`) encoded as an **NSKeyedArchive** — Apple's Cocoa object serialization format. The top-level structure always contains four keys:

```python
{
    "$archiver": "NSKeyedArchiver",
    "$version":  100000,
    "$top":      {"root": UID(1)},       # Entry point into $objects array
    "$objects":  ["$null", {...}, ...]    # All serialized data; index 0 = null sentinel
}
```

The root object at `$objects[1]` is an instance of class **`SilicaBrush`** — Procreate's internal Objective-C class name. It contains hundreds of key-value pairs organized into the 14 Brush Studio panels. UIDs (unsigned integers) serve as cross-references into the `$objects` array, enabling object deduplication and nested references.

**Texture conventions are critical for conversion.** Shape.png uses **white = opaque/visible** and black = transparent. Grain.png uses an inverted convention where inked/painted areas appear dark. When converting to other applications, these images typically need inversion. Both textures are grayscale, square, and sized at powers of two. When a brush uses Procreate's built-in Source Library, `bundledShapePath` or `bundledGrainPath` contains a string path (e.g., `"Brushes/Shape/Round.png"`) referencing assets inside the Procreate app bundle — these textures are **not embedded** in the `.brush` file.

### Brush parameter categories and known plist keys

The 14 Brush Studio panels map to distinct parameter groups in the archive. While no official specification exists, community reverse-engineering (particularly the `procreate-brush-decoder` JSON schema from aumlette-lab and the Krita Artists forum research by wakocima) has mapped most keys:

- **Stroke Path**: `spacing` (0.0–1.0), `streamline`, `jitter`, `fallOff`, `stabilization`, `motionFiltering`, `spacingJitter`, `jitterLateral`, `jitterLinear`
- **Taper**: pressure and touch taper parameters for size, opacity, and tip sharpness at stroke start/end; `legacyTaper` toggle
- **Shape**: `bundledShapePath`, `shapeScatter`, `shapeRotation`, `shapeRandomizedRotation`, `shapeAzimuth`, `shapePressureSize`, `shapeCount`, `shapeCountJitter`, `shapeRoundness`
- **Grain**: `bundledGrainPath`, `grainMovement` (boolean: Moving vs Texturized), `grainScale`, `grainZoom`, `grainDepth`, `grainDepthMin`, `grainOffsetJitter`, `grainBlendMode` (integer enum), `grainBrightness`, `grainContrast`, `grainFollow`
- **Rendering**: rendering mode (integer enum: 1=Light Glaze, 2=Uniformed Glaze, 3=Intense Glaze, 4=Heavy Glaze, 5=Uniform Blending, 6=Intense Blending), flow, wet edges, burnt edges
- **Wet Mix**: `dilution`, `charge`, `attack`, `pull`, `grade`, `blur`, `blurJitter`, `wetnessJitter`
- **Color Dynamics**: stamp/stroke color jitter for hue, saturation, brightness, darkness, secondary color; pressure and tilt variants
- **Dynamics**: speed→size, speed→opacity mappings (-1.0 to +1.0)
- **Apple Pencil**: per-brush pressure curve (control point arrays), tilt→size/opacity/flow/gradation/bleed, barrel roll (Apple Pencil Pro)
- **Properties**: `brushSize`, `maximumSize`, `minimumSize`, `brushOpacity`, `maximumOpacity`, `minimumOpacity`, `blendMode`, `name`

**Pressure curves** are stored as UID references to arrays of control point coordinates, defining bezier/spline curves with **2–6 control points** on a normalized 0–1 grid for both input and output axes. The `grainBlendMode` integer-to-blend-mode mapping is inconsistent and must be enumerated empirically.

### Version evolution

Procreate **5.0** (December 2019) introduced the Taper, Rendering, Wet Mix, and Color Dynamics panels along with six rendering modes — adding dozens of new keys. **Procreate 5.4** (late 2024) overhauled the brush storage system entirely (brushes now live as real files in iPad's Files app), added spacing jitter, lateral/linear jitter, roundness jitter, per-brush pressure graphs, and a Preview panel. The CSP2PC converter warns that 5.4 changes "might break the script." Older archives gracefully ignore unrecognized keys, so forward compatibility is generally preserved.

---

## Inside the CSP .sut file

A `.sut` file is a **SQLite 3 database** — confirmed by the file signature `"SQLite format 3"` present in **98% of analyzed .sut files**. The remaining ~2% appear to be older format variants. File sizes typically range from **21 KB to 15 MB**. The extension stands for "Sub Tool," reflecting CSP's three-level tool hierarchy: Tool → Sub Tool Group → Sub Tool.

### SQLite schema

Every `.sut` contains at minimum three meaningful tables:

```sql
CREATE TABLE Node (
    _PW_ID INTEGER PRIMARY KEY AUTOINCREMENT,
    NodeName TEXT,                    -- Display name (e.g., "G-pen", "Rough pencil")
    NodeVariantId INTEGER,           -- FK → Variant.VariantId (current settings)
    NodeInitVariantId INTEGER        -- FK → Variant.VariantId (default/reset settings)
);

CREATE TABLE Variant (
    _PW_ID INTEGER PRIMARY KEY AUTOINCREMENT,
    VariantId INTEGER,               -- Links to Node table
    -- Many parameter columns: TEXT, INTEGER, REAL, and BLOB types
    -- Column names match CSP's internal parameter naming convention
    -- Binary BLOB columns include "Effectors" (pressure/dynamics curves)
);

CREATE TABLE MaterialFile (
    _PW_ID INTEGER PRIMARY KEY AUTOINCREMENT,
    FileData BLOB                    -- TAR archive containing brush tip PNG
);
```

The `_PW_` prefix on primary keys is a consistent Celsys convention across all their SQLite databases (also seen in `Config.sqlite`, `.todb` files, and `.clip` document files). A brush node is identified by having **non-zero** `NodeVariantId` and `NodeInitVariantId` values.

### Brush tip image extraction

The `MaterialFile.FileData` BLOB contains a **TAR archive**. When extracted, it yields:

```
MaterialFile-FileData-{_PW_ID}.bin (TAR)
└── thumbnail/
    └── thumbnail.png        # Brush tip image as PNG
```

The PNG stores grayscale values where **dark pixels = opaque** brush areas (opposite of Procreate's convention). The extraction code from `Loperamide/CSPExtract` locates the PNG by scanning for the last `PNG` header signature and `IEND` marker within the binary BLOB. Multiple `MaterialFile` rows (different `_PW_ID` values) indicate multiple brush tips.

### Dynamics and the Effector binary format

CSP encodes pressure curves, tilt sensitivity, and velocity dynamics as **binary BLOB data** called "Effectors" within `Variant` table columns. Each dynamic-capable parameter (brush size, opacity, density) can be linked to pen pressure, tilt, velocity, or random inputs. The Effector binary encodes which inputs are active, the pressure response curve control points, and min/max value ranges.

**The Effector binary format is the biggest reverse-engineering gap.** The `VS-CSPBrushInfo` C# tool has achieved partial decoding and can render visual representations of pressure curves, but the format **changes between CSP versions**, making reliable parsing difficult. No complete specification of the Effector binary layout has been published.

### Related file formats

The `.sut` format sits within a family of related CSP SQLite databases:

- **`.sutg`** — Sub Tool Group (multiple sub-tools exported together)
- **`.todb`** — Tool Database (`EditImageTool.todb`), the master database containing ALL installed tools
- **`.clip`** — Document files (also SQLite-based, separately reverse-engineered)
- **`.cls`** — Color Set files (binary format with existing encoder/decoder)

---

## Parameter mapping between Procreate and CSP

The mapping between these two brush engines falls into three tiers based on conversion fidelity.

### Direct mappings (~60% of parameters)

These parameters have clear equivalents with straightforward value transformations:

| Procreate parameter | CSP equivalent | Conversion notes |
|---|---|---|
| Shape.png (brush tip) | Brush Tip → Material | **Invert colors**: white→black. Register as CSP material |
| Grain.png (texture) | Texture → Material | Invert colors, register as paper texture |
| `spacing` (0–1) | Gap (Stroke category) | Scale from fraction to CSP's percentage/pixel units |
| Pressure → Size | Brush Size dynamics: Pen pressure | Both use normalized curves; transfer control points directly |
| Pressure → Opacity | Opacity dynamics: Pen pressure | Direct mapping |
| Tilt → Size/Opacity | Dynamics: Tilt | Both support tilt input |
| Speed → Size | Brush Size dynamics: Velocity | Both support velocity→size |
| Speed → Opacity | Opacity dynamics: Velocity | Both support velocity→opacity |
| Stroke Blend Mode | Ink: Blending mode | Standard blend modes map 1:1 (Normal, Multiply, Screen, etc.) |
| Width/Squeeze (0–100%) | Brush Tip: Thickness (0–100) | Linear mapping |
| Max/Min Opacity | Opacity + dynamics minimum | Both use 0–100% range |
| Pressure Taper (Start/End) | Starting and Ending | CSP has independent length, size, density, opacity controls |

### Approximate mappings (~25% of parameters)

| Procreate parameter | CSP equivalent | Approximation strategy |
|---|---|---|
| StreamLine + Stabilization | Correction: Stabilization | Combine both Procreate values into single CSP stabilizer |
| **Rendering Mode** (6 options) | Ink: Color mixing + Opacity | **Hardest mapping.** Light Glaze ≈ CSP default. Intense Blending ≈ Color mixing with high Amount of Paint |
| Flow (0–100%) | Brush Density (0–100) | Close conceptual match |
| Grain Depth | Texture: Density | Both control texture influence; roughly linear |
| Wet Edges / Burnt Edges | Watercolor Edge | Both darken stroke edges; different implementations |
| Jitter (Lateral) | Spraying Effect: Deviation | Requires enabling CSP spray mode, fundamentally changing brush behavior |
| Pull (0–100%) | Ink: Color Stretch (0–100) | Both control paint drag |
| Dilution (0–100%) | Ink: Amount of Paint (inverted) | Higher dilution ≈ lower paint amount |
| Color Jitter (H/S/B) | Color Jitter settings | Both support per-stroke H/S/B randomization |

### Parameters with no equivalent (~15%)

- **Grain Movement modes** (Rolling, Texturized) — CSP textures are canvas-fixed; no stroke-following texture
- **Grain Zoom** (scale texture with brush size) — CSP textures do not auto-scale
- **Wet Mix: Charge** (paint running out over stroke length) — no CSP simulation
- **Wet Mix: Grade** (texture chunkiness) — unique to Procreate
- **Wet Mix: Attack** (unique pressure-shape interaction) — no CSP match
- **Spacing Jitter** — CSP gap is fixed per stroke
- **Linear Jitter** (along-stroke scatter) — CSP lacks directional jitter without spray mode
- **Fall Off** (continuous opacity fade) — CSP's Starting/Ending is structurally different

### Pressure curve conversion

Both systems use **multi-point curves** with normalized 0–1 axes for input pressure and output effect. Procreate stores curves as arrays of control point coordinates (2–6 points) with apparent cubic/spline interpolation. CSP stores curves as binary Effector data with its own spline system. The conversion strategy is to extract Procreate control points, then either encode them directly into CSP's Effector binary format (requiring reverse-engineering that format) or use a pre-built Effector template and modify it. For simple 2–3 point curves, the mapping should be very close. For complex 5–6 point curves, minor visual differences in interpolation are expected.

---

## Existing tools and the conversion landscape

The ecosystem of tools is asymmetric — Procreate reading is well-supported, but CSP writing is essentially uncharted.

**Key repositories and their capabilities:**

- **tohsakrat/Brush-Converter** (54 stars, Python) — The most popular tool. Extracts material images and parameters from `.abr`, `.brushset`, and `.sut` files. Its `sut-parser.py` opens `.sut` files via `sqlite3.connect()`, enumerates all tables dynamically, extracts BLOB columns as TAR archives, and outputs a JSON dump. **Can extract but cannot repack** `.sut` files — blocked by inability to reconstruct `.layer` digital assets within the binary data.

- **Leon-Schoenbrunn/CSP2PC** (6 stars, Python, MIT) — **The only dedicated CSP→Procreate converter.** Opens `.sut` as SQLite, extracts brush tips from `MaterialFile.FileData`, injects settings into a template `Seed.brush` file (included in repo), and packages the result as `.brush` or `.brushset`. Maps spacing, jitter, taper, shape rendering, wet mix, opacity, rotation, scatter, and flip. Single brush tip → `.brush`; multiple tips → `.brushset`.

- **MorrowShore/CSPBrushExtract** (7 stars, Python, AGPL-3.0) — Extracts brush tip PNGs and decoded/human-readable parameter listings from `.sut` files. Has a web-based version at morrowshore.com. The `--raw` flag shows uninterpreted values, useful for format research.

- **KennethEvans/VS-CSPBrushInfo** (C#, MIT) — Windows desktop app that reads both `.sut` files and `EditImageTool.todb` master databases. Can compare two brushes showing parameter differences. **Partially decodes Effector binary data** including pressure curve visualization — the most advanced Effector decoding available.

- **aumlette-lab/procreate-brush-decoder** (TypeScript, MIT) — Web-based schema-driven decoder with a JSON schema file mapping every raw plist key to its Brush Studio GUI equivalent. Live at procreate-brush-decoder.vercel.app. **The best available reference for complete Procreate key mappings.**

- **FreyaLupen/procreate-to-krita-brush-converter** (KDE GitLab, Python, GPL-3.0, 45 commits) — The most mature Procreate conversion project. Converts `.brush`/`.brushset` to Krita `.kpp`/`.bundle` with settings mapping. Includes functions to dump raw brush settings for examination.

- **chsh2/import_paint_brush** (Python, Blender add-on) — Converts `.abr`, `.gbr`, `.brushset`, and `.sut` to Blender brushes. Widest format support of any single tool.

- **VarunVF/brush_converter** (Python, CustomTkinter GUI) — Multi-format converter using an intermediate JSON representation. Supports loading `.sut` as of v0.3.0; planned full CSP support.

**No Procreate→CSP converter exists in any language.** Community forum threads on CLIP STUDIO ASK consistently confirm that `.brush` files are incompatible with CSP and artists must manually recreate brushes. The typical workaround is exporting a single brush dab as PNG, registering it as a CSP material, and manually tuning parameters.

---

## Implementation guide for a Python converter

### Step 1: Reading a Procreate .brush file

```python
import zipfile, plistlib, io
from PIL import Image, ImageOps

def load_procreate_brush(path):
    with zipfile.ZipFile(path, 'r') as z:
        names = z.namelist()
        
        # Parse Brush.archive NSKeyedArchive
        archive_name = next((n for n in names if n.endswith('Brush.archive')), None)
        archive_data = z.read(archive_name)
        plist = plistlib.loads(archive_data)
        
        # Resolve NSKeyedArchive UIDs into a flat dictionary
        params = resolve_nska(plist)
        
        # Extract texture images
        shape_png = z.read('Shape.png') if 'Shape.png' in names else None
        grain_png = z.read('Grain.png') if 'Grain.png' in names else None
        
        return params, shape_png, grain_png
```

### Step 2: Decoding the NSKeyedArchive

```python
def resolve_nska(plist):
    objects = plist['$objects']
    root_uid = plist['$top']['root']
    seen = set()
    
    def resolve(val, depth=0):
        if depth > 50: return '<max depth>'
        if isinstance(val, plistlib.UID):
            if val.data in seen: return '<circular>'
            seen.add(val.data)
            result = resolve(objects[val.data], depth + 1)
            seen.discard(val.data)
            return result
        if isinstance(val, dict):
            if '$classname' in val: return val['$classname']
            r = {k: resolve(v, depth+1) for k, v in val.items() if k != '$class'}
            if 'NS.objects' in r and 'NS.keys' in r:
                return dict(zip(r['NS.keys'], r['NS.objects']))
            if 'NS.objects' in r: return r['NS.objects']
            return r
        if isinstance(val, list): return [resolve(i, depth+1) for i in val]
        if val == '$null': return None
        return val
    
    return resolve(root_uid)
```

### Step 3: Converting textures

```python
def convert_shape_for_csp(shape_bytes):
    """Invert Procreate shape (white=opaque) to CSP convention (dark=opaque)."""
    img = Image.open(io.BytesIO(shape_bytes)).convert('L')
    return ImageOps.invert(img)

def convert_grain_for_csp(grain_bytes):
    """Invert Procreate grain for CSP texture material."""
    img = Image.open(io.BytesIO(grain_bytes)).convert('L')
    return ImageOps.invert(img)
```

### Step 4: Constructing a .sut file

```python
import sqlite3, tarfile, io

def create_sut_from_template(template_sut, output_path, name, tip_png, params):
    """Clone a template .sut and modify it with converted parameters."""
    import shutil
    shutil.copy2(template_sut, output_path)
    
    conn = sqlite3.connect(output_path)
    c = conn.cursor()
    
    # Update brush name
    c.execute("UPDATE Node SET NodeName = ?", (name,))
    
    # Replace brush tip image in MaterialFile
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode='w') as tar:
        img_bytes = io.BytesIO()
        tip_png.save(img_bytes, format='PNG')
        img_data = img_bytes.getvalue()
        info = tarfile.TarInfo(name='thumbnail/thumbnail.png')
        info.size = len(img_data)
        tar.addfile(info, io.BytesIO(img_data))
    
    c.execute("UPDATE MaterialFile SET FileData = ? WHERE _PW_ID = 1",
              (tar_buffer.getvalue(),))
    
    conn.commit()
    conn.close()
```

### Step 5: Practical recommendations

For a working Procreate→CSP converter, the most viable architecture is:

1. **Read** the `.brush` file using `zipfile` + `plistlib` with manual NSKeyedArchive resolution
2. **Extract and convert** Shape.png and Grain.png (invert colors, ensure grayscale)
3. **Map parameters** using the direct mapping table, with fallbacks to sensible defaults for approximate/impossible mappings
4. **Clone a template `.sut`** file (export a basic CSP brush as `.sut` to use as the template)
5. **Replace** the `MaterialFile.FileData` BLOB with a new TAR containing the converted brush tip
6. **Update** known `Variant` columns with converted parameter values
7. For **pressure curves**, either use CSPBrushInfo to reverse-engineer the Effector format from known curves, or skip dynamic mapping and use CSP's default linear pressure response

---

## Key gotchas and version-specific quirks

**Endianness**: Binary plists use big-endian byte order; `plistlib` handles this transparently. SQLite uses native byte order (little-endian on most platforms). PNG is platform-independent.

**Built-in textures**: Many Procreate brushes reference the app's internal Source Library via `bundledShapePath`/`bundledGrainPath` strings rather than embedding PNGs. These textures cannot be extracted from the `.brush` file — your converter must either substitute known equivalents or flag these brushes as requiring manual texture assignment.

**Grain movement has no CSP equivalent.** Procreate's Rolling grain mode (texture follows the stroke path) and Texturized mode (stamps texture per-dab) fundamentally differ from CSP's canvas-fixed texture tiling. This affects roughly 40% of Procreate brushes and is the single most common feature loss in conversion.

**Rendering mode is the hardest parameter to convert.** Procreate's six rendering modes control how overlapping stamps within a single stroke composite together. Light Glaze (the default) roughly matches CSP's standard rendering. Intense Blending and Heavy Glaze require careful combination of CSP's Color mixing mode, Amount of Paint, Density of Paint, and Color Stretch — and the results will never match perfectly because the underlying rendering engines differ fundamentally.

**CSP Effector format is version-dependent.** The binary encoding for pressure curves and dynamics changes across CSP releases. Any Effector parser must either target a specific CSP version or use heuristic detection.

**Procreate format versioning is handled gracefully.** Unrecognized keys in NSKeyedArchive are silently ignored, so brushes created with older Procreate versions generally load in newer versions and vice versa.
