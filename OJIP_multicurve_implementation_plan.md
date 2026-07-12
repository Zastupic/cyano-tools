# OJIP Multi-Curve File Support — Implementation Plan

**Date:** 2026-07-10
**Context:** Planning session for adding multi-curve FluorPen file support to cyano.tools OJIP analysis tool
**Trigger:** Alexey Shapiguzov (University of Helsinki / LUKE) tested the tool with a FluorPen multi-curve export file. The tool currently only reads the first column, ignoring all other curves in the file. Meeting with Alexey scheduled for Monday July 14 at 4 PM CET / 5 PM Helsinki time to discuss data handling and requirements.

---

## 1. Current System Overview

### Architecture

| Component | File | Lines | Role |
|-----------|------|-------|------|
| HTML Template | `website/templates/OJIP_analysis.html` | ~1700 | UI with 6 tabs: Curves, Parameters, Groups & Averages, Diagnostics, Interpretation, Annotation |
| Backend Blueprint | `website/OJIP_data_analysis.py` | 912 | Main analysis engine, file parsing, JIP parameter calculation, XLSX export |
| Interpretation | `website/ojip_interpretation.py` | 2090 | Biological interpretation engine (5 categories + validity gates) |
| Annotation | `website/fluorescence_annotation.py` | 2356 | MIAPPE-compatible metadata & annotation system |
| Frontend JS | `website/static/js_OJIP.js` | 1815 | File uploads, API calls, Chart.js rendering, publication figure export |

### API Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/OJIP_data_analysis` | GET | Render UI page |
| `/api/ojip_process` | POST | Parse files & compute JIP parameters |
| `/api/ojip_refit` | POST | Refit splines with new knot reduction factor |
| `/api/ojip_interpret` | POST | Biological interpretation of JIP parameters |
| `/api/ojip_add_charts` | POST | Create summary XLSX with charts |
| `/api/fluorescence_annotation/ingest_from_ojip` | POST | Populate annotation from OJIP data |
| `/api/fluorescence_annotation/export` | POST | Export annotated bundle (ZIP) |

### Current Single-Curve AquaPen/FluorPen Parsing

In `OJIP_data_analysis.py`, the AquaPen branch (`fluorometer == 'Aquapen'`):

1. Reads file as UTF-8 text, splits into lines
2. Splits each line on `\t`, takes only first 2 columns
3. Validates header contains "FluorPen" or "AquaPen"
4. Filters rows where first column is numeric (strips all header/footer lines)
5. Renames columns to `time_us` (microseconds) and `<filename>`
6. Merges multiple files on `time_us` via outer join

**This is why multi-curve files only show one curve** — `iloc[:, :2]` on line 339 takes only the first two columns, discarding all other measurement columns.

### Supported Fluorometers

| Instrument | Manufacturer | File Type | Time Unit | Separator |
|-----------|--------------|-----------|-----------|-----------|
| MULTI-COLOR-PAM II / Dual-PAM 100 | Heinz Walz | CSV | ms | `;` |
| AquaPen / FluorPen | PSI | TXT | us | `\t` |
| FL 6000 | PSI | TXT | s | `\t` |

### Current Data Pipeline

```
Upload files → Parse per fluorometer format → Merge on time axis (outer join + interpolation)
→ Normalize (4 modes: raw, shifted F0, shifted FM, double-normalized)
→ Spline fitting (LSQUnivariateSpline with knot reduction)
→ 1st & 2nd derivatives on log-time grid
→ FJ/FI/FP detection (derivative minima + polynomial inflection points)
→ JIP parameter calculation (30+ parameters)
→ Complementary areas (O-J, J-I, I-P, O-P)
→ JSON response → Frontend rendering
```

### Current Capabilities (all must work with multi-curve files)

- **Curves tab**: 4 normalization modes, interactive chart, editable FJ/FI table with live recalculation
- **Parameters tab**: 4 parameter groups (quantum yields, energy fluxes, areas & indices, technical), bar charts + tables
- **Groups & Averages tab**: Sample-to-group assignment (auto-detect from filename prefix or manual), mean +/- SD curves, publication-quality figure export with customizable styling
- **Diagnostics tab**: O-J region, J-I region, K-step presence
- **Interpretation tab**: 5 biological interpretation categories (PQ-redox poise, PSII max yield, electron transport, PSI limitation, OEC status), organism-dependent thresholds, validity gates, optional LLM narrative
- **Annotation tab**: MIAPPE-compatible 4-tier metadata (Investigation, Study, Fluorometer, Per-curve), provenance tracking, bundle download (ZIP with Parquet + JSON)

---

## 2. Multi-Curve File Format Analysis

### Example File: `1580.txt` (from Alexey's FluorPen)

- **Size:** 2.8 MB
- **Total lines:** 595
- **Total columns:** 757 (1 label column + 756 measurement columns)
- **Measurement count:** 756 OJIP curves
- **Time span:** April 30 – May 11, 2026 (~20-minute intervals between measurements)

### File Structure (Transposed Layout)

```
Line 1:  FluorPen ASCII Export File
Line 2:  -----------------------------------
Line 3:  File Name: Untitled - 1
Line 4:  -----------------------------------
Line 5:  (blank)
Line 6:  index<TAB>1<TAB>2<TAB>3<TAB>...<TAB>756          ← measurement indices
Line 7:  time<TAB>19:44:19  30.4.2026<TAB>20:04:19  30.4.2026<TAB>...  ← timestamps
Line 8:  id<TAB>OJIP<TAB>OJIP<TAB>OJIP<TAB>...             ← protocol type per curve
Lines 9–557:  <time_us><TAB><F1><TAB><F2><TAB>...<TAB><F756>  ← fluorescence data
Lines 558–595: <param_name><TAB><val1><TAB><val2><TAB>...     ← pre-computed parameters + metadata
```

### Data Rows (Lines 9–557): 549 Time Points

Time axis in microseconds (same as single-curve AquaPen):
```
11, 21, 31, 41, 51, ... 991           (10 us steps, 0.01–1 ms)
1001, 1051, 1101, ... 1951            (50 us steps, 1–2 ms)
2001, 2101, 2201, ... 4901            (100 us steps, 2–5 ms)
5001, 5101, ... 14901                 (100 us steps, 5–15 ms)
15001, 15501, 16001, ... 24501        (500 us steps, 15–25 ms)
25001, 26001, 27001, ... 99001        (1000 us steps, 25–99 ms)
100001, 101001, ... 200001            (1000 us steps, 100–200 ms)
210001, 220001, ... 500001            (10000 us steps, 210–500 ms)
510001, ... 1000001                   (10000 us steps, 510–1000 ms)
1010001, ... 2000001                  (10000 us steps, 1010–2000 ms)
```

This covers the full OJIP transient from ~10 us to 2 seconds.

### Footer/Parameter Rows (Lines 558–595): Pre-Computed Values

| Row Label | Description | Example Values |
|-----------|-------------|----------------|
| `Bckg` | Background signal | 8517, 6729 |
| `Fo` | Minimal fluorescence | 25131, 25944 |
| `Fj` | Fluorescence at J-step | 64307, 61641 |
| `Fi` | Fluorescence at I-step | 99256, 93860 |
| `Fm` | Maximal fluorescence | 108847, 102605 |
| `Fv` | Variable fluorescence (Fm - Fo) | 83716, 76661 |
| `Vj` | Relative variable fluorescence at J | 0.468, 0.466 |
| `Vi` | Relative variable fluorescence at I | 0.885, 0.886 |
| `Fm/Fo` | Ratio | 4.331, 3.955 |
| `Fv/Fo` | Ratio | 3.331, 2.955 |
| `Fv/Fm` | Max PSII quantum yield | 0.769, 0.747 |
| `Mo` | Initial O-J slope | 1.095, 1.142 |
| `Area` | Complementary area | 29321732, 28758366 |
| `Fix Area` | Fixed area | 107154800, 101270056 |
| `HACH Area` | HACH area | 82024808, 75327096 |
| `Sm` | Normalized area | 350.252, 375.137 |
| `Ss` | Shape parameter | 0.427, 0.408 |
| `N` | QA turnover number | 819.699, 919.740 |
| `Phi_Po` | Max quantum yield of PSII | 0.769, 0.747 |
| `Psi_o` | Efficiency of QA- reoxidation | 0.532, 0.534 |
| `Phi_Eo` | Quantum yield of electron transport | 0.409, 0.399 |
| `Phi_Do` | Quantum yield of dissipation | 0.231, 0.253 |
| `Phi_Pav` | Average quantum yield | 962.085, 966.487 |
| `Pi_Abs` | Performance index (abs) | 1.245, 1.033 |
| `ABS/RC` | Absorption flux per RC | 3.043, 3.281 |
| `TRo/RC` | Trapped exciton flux per RC | 2.340, 2.452 |
| `ETo/RC` | Electron transport flux per RC | 1.245, 1.310 |
| `DIo/RC` | Dissipated energy flux per RC | 0.703, 0.830 |
| `FLASH-Wavelength [nm]` | Flash LED wavelength | 455.00 |
| `FLASH-Percent [%]` | Flash intensity percent | 30.00 |
| `FLASH-Intensity [uE]` | Flash intensity (uE) | -NAN (not calibrated) |
| `SUPER-Wavelength [nm]` | Saturation pulse wavelength | 455.00 |
| `SUPER-Percent [%]` | Saturation pulse percent | 97.00 |
| `SUPER-Intensity [uE]` | Saturation pulse intensity | -NAN |
| `ACTINIC-Wavelength [nm]` | Actinic light wavelength | 455.00 |
| `ACTINIC-Percent [%]` | Actinic light percent | 10.00 |
| `ACTINIC-Intensity [uE]` | Actinic light intensity | 100.00 |
| `description` | User description | (empty) |

### Key Differences from Single-Curve Format

| Aspect | Single-Curve | Multi-Curve |
|--------|-------------|-------------|
| Columns | 2 (time + 1 fluorescence) | N+1 (time/index + N fluorescence) |
| Header | Device name, separator lines | Same + index/time/id rows |
| Data layout | Vertical (rows = time points) | Matrix (rows = time, cols = curves) |
| Parameters | Not included | 38 rows at bottom of file |
| Timestamps | Not in file | Per-curve timestamps in row 7 |
| Protocol ID | Not in file | Per-curve in row 8 (e.g., "OJIP") |
| Instrument settings | Not in file | FLASH/SUPER/ACTINIC settings in footer |

---

## 3. Implementation Plan

### Design Principle

**Detect and parse the multi-curve format, then feed extracted curves into the existing pipeline unchanged.** All downstream processing (normalization, spline fitting, JIP parameters, derivatives, areas, interpretation, annotation, export) works identically whether curves came from separate files or a single multi-curve file.

### Architecture

```
User selects file
    ↓
JS FileReader detects multi-curve (client-side, fast)
    ↓
Selection UI modal (client-side)
  - Shows curve count, date range, timestamps
  - Naming scheme selector
  - Checkbox selection (max 100)
    ↓
Upload file + selection params → Server
    ↓
_parse_multicurve_aquapen() extracts selected curves
    ↓
Builds Summary_file DataFrame (identical format to multi-file upload)
    ↓
Existing JIP pipeline runs unchanged
    ↓
JSON response (+ instrument_metadata)
    ↓
Existing frontend renders normally
    ↓
Interpretation tab: instrument settings pre-filled from metadata
```

### 3.1 Frontend: Client-Side Detection & Selection UI

#### File Detection (in `js_OJIP.js`)

When user selects file(s) and fluorometer is AquaPen:
1. Use `FileReader.readAsText()` to scan the file
2. Split into lines, check if line index 5 (0-based) starts with `index\t`
3. If yes AND has >2 tab-separated fields → multi-curve file detected
4. Parse full file client-side to extract:
   - Curve count (number of tab-separated fields on line 6 minus 1)
   - Timestamps array (from line 7, split on `\t`)
   - Protocol IDs array (from line 8) — filter to show only OJIP curves
   - Instrument settings from footer rows (FLASH/SUPER/ACTINIC)

#### Selection Modal (new HTML in `OJIP_analysis.html`)

```
┌─────────────────────────────────────────────────────────┐
│  Multi-Curve File Detected                              │
│  File: 1580.txt — 756 OJIP curves                      │
│  Date range: 30.4.2026 – 11.5.2026                     │
│                                                         │
│  Naming scheme: [Timestamp ▾] / Index / Filename+Index  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ [✓] #1   19:44:19  30.4.2026   OJIP            │    │
│  │ [✓] #2   20:04:19  30.4.2026   OJIP            │    │
│  │ [✓] #3   20:24:19  30.4.2026   OJIP            │    │
│  │ [ ] #4   20:44:19  30.4.2026   OJIP            │    │
│  │ ...                                              │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  [Select All] [Deselect All] [Select Range: __ to __]   │
│  Selected: 3 of 756 (max 100)                           │
│                                                         │
│  [Cancel]                        [Analyze Selected →]   │
└─────────────────────────────────────────────────────────┘
```

Features:
- Scrollable table with checkboxes, index, timestamp, protocol
- **Naming scheme dropdown** with 3 options:
  - **Timestamp**: e.g., `19:44:19 30.4.2026`
  - **Index**: e.g., `1`, `2`, `3`
  - **Filename + Index**: e.g., `1580_001`, `1580_002`
- Select All / Deselect All / Select Range controls
- Warning when >100 curves selected (enforce limit)
- Prevent mixing multi-curve files with other single-curve files

#### FormData Construction

When user clicks "Analyze Selected":
```javascript
formData.append('OJIP_files', file);
formData.append('is_multicurve', 'true');
formData.append('multicurve_indices', JSON.stringify([0, 1, 2, ...]));  // 0-based column indices
formData.append('multicurve_naming', 'timestamp');  // or 'index' or 'filename_index'
// + existing params: fluorometer, FJ_time, FI_time, knots_reduction_factor, etc.
```

### 3.2 Backend: Modified AquaPen Parsing

#### New Helper Function: `_parse_multicurve_aquapen()`

```python
def _parse_multicurve_aquapen(file_stream, selected_indices, naming_scheme, filename_stem):
    """
    Parse a FluorPen multi-curve ASCII export file.

    Args:
        file_stream: File content as bytes/string
        selected_indices: List of 0-based column indices to extract
        naming_scheme: 'timestamp' | 'index' | 'filename_index'
        filename_stem: Original filename without extension

    Returns:
        (df, metadata) where:
        - df: DataFrame with columns [time_us, curve1_name, curve2_name, ...]
        - metadata: dict with instrument settings extracted from footer
    """
```

Implementation:
1. Read all lines, split on `\t`
2. Parse header rows:
   - Line 6 (index 5): measurement indices
   - Line 7 (index 6): timestamps
   - Line 8 (index 7): protocol IDs
3. Parse data rows: rows where first column is numeric integer
4. Parse footer rows: rows after data where first column is a known parameter name
5. Extract only selected columns
6. Apply naming scheme to generate column names
7. Build DataFrame with `time_us` as first column
8. Extract instrument metadata from footer (FLASH/SUPER/ACTINIC settings)
9. Return (DataFrame, metadata)

#### Modified `ojip_process` Route

In the AquaPen branch, add check for `is_multicurve`:

```python
elif fluorometer in ('Aquapen', 'FL6000'):
    is_multicurve = request.form.get('is_multicurve') == 'true'

    if is_multicurve and fluorometer == 'Aquapen':
        # Multi-curve parsing
        mc_indices = json.loads(request.form.get('multicurve_indices', '[]'))
        mc_naming = request.form.get('multicurve_naming', 'index')
        raw_content = file.read().decode('utf-8', errors='replace')

        Summary_file, instrument_metadata = _parse_multicurve_aquapen(
            raw_content, mc_indices, mc_naming, fname_no_ext)

        file_names_list = list(Summary_file.columns[1:])
        # Skip the normal per-file loop — Summary_file is fully built
        break
    else:
        # Existing single-curve parsing (unchanged)
        ...
```

The returned `Summary_file` has the exact same structure as if multiple single-curve files were uploaded:
```
time_us | curve_name_1 | curve_name_2 | ... | curve_name_N
11      | 8517         | 6729         | ... | ...
21      | 31438        | 30430        | ... | ...
...
```

**Everything downstream is unchanged.**

#### JSON Response Addition

Add `instrument_metadata` field to the response when available:

```python
response = {
    'status': 'success',
    'fluorometer': fluorometer,
    'files': data_cols,
    'time_raw_ms': time_raw_ms,
    'time_log_ms': time_log_ms,
    'curves': curves,
    'key_values': key_values,
    # NEW: only present for multi-curve files
    'instrument_metadata': {
        'flash_wavelength_nm': 455.0,
        'flash_percent': 30.0,
        'flash_intensity_uE': None,       # -NAN → None
        'super_wavelength_nm': 455.0,
        'super_percent': 97.0,
        'super_intensity_uE': None,
        'actinic_wavelength_nm': 455.0,
        'actinic_percent': 10.0,
        'actinic_intensity_uE': 100.0,
        'timestamps': ['19:44:19  30.4.2026', ...],  # for selected curves
    }
}
```

### 3.3 Frontend: Instrument Metadata Auto-Population

When `instrument_metadata` is present in the response:

- **Interpretation tab**: Auto-fill measurement fields:
  - Instrument → "aquapen"
  - Saturation pulse intensity (from SUPER-Intensity, if not -NAN)
  - Actinic light info
- **Annotation tab**: Auto-fill fluorometer settings fields where applicable

### 3.4 Files to Modify

| File | Changes | Scope |
|------|---------|-------|
| `website/OJIP_data_analysis.py` | Add `_parse_multicurve_aquapen()` helper; modify AquaPen branch in `ojip_process` to detect and handle multi-curve files; add `instrument_metadata` to response | ~80-120 new lines |
| `website/static/js_OJIP.js` | Add client-side file detection function; selection modal logic; naming scheme handler; FormData construction for multi-curve; instrument metadata auto-population | ~200-250 new lines |
| `website/templates/OJIP_analysis.html` | Add selection modal HTML/CSS | ~80-100 new lines |

**No changes needed to:**
- `website/ojip_interpretation.py` (interpretation engine)
- `website/fluorescence_annotation.py` (annotation system)
- `website/static/js_fluorescence_annotation.js` (annotation UI)
- Any other files

### 3.5 Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Non-OJIP curves in file | Filter `id` row — only show/allow curves where `id == "OJIP"` |
| Mixed upload (multi + single files) | Prevent: if multi-curve detected, enforce single-file mode |
| More than 100 curves selected | Block with warning, enforce 100-curve limit |
| Missing footer/metadata rows | Gracefully skip — `instrument_metadata` will be `null` |
| `-NAN` values in metadata | Convert to `None`/`null` |
| Empty `description` row | Ignore |
| `Bckg` (background) values | Extract and include in metadata for reference, but do NOT subtract from raw data (F0 handling is already in the pipeline) |
| Very large files (>1000 curves) | Client-side parsing handles it (text splitting is fast); server limited to 100 selected curves |
| File with only 1 curve | Falls through to normal single-curve parsing (multi-curve detection requires >2 columns) |

---

## 4. What Stays Unchanged

The following features work identically whether curves come from separate files or a multi-curve file:

- All 30+ JIP parameter calculations (F0, FM, FK, FJ, FI, FV, VJ, VI, M0, psiE0, psiR0, etc.)
- Spline fitting with adjustable knot reduction factor
- 1st and 2nd derivative computation on log-time grid
- Polynomial O-J and J-I fitting with inflection point detection
- FJ/FI timing auto-detection (derivative minima) and manual adjustment
- 4 normalization modes (raw, shifted F0, shifted FM, double-normalized)
- Complementary area calculations (O-J, J-I, I-P, O-P)
- Grouping & averages with auto-detect from name prefix
- Publication-quality figure export (all style options)
- Biological interpretation (all 5 categories + validity gates)
- MIAPPE-compatible annotation (4-tier metadata, provenance tracking)
- Bundle export (ZIP with Parquet + JSON + manifest)
- XLSX export (all sheets: parameters, charts, curves, derivatives, methods)
- Refit endpoint (`/api/ojip_refit`)

---

## 5. Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Curve selection | Selection UI with 100-curve limit | 756 curves would overwhelm the analysis pipeline and UI; user picks relevant subset |
| Curve naming | User selects from 3 options (Timestamp / Index / Filename+Index) | Different use cases benefit from different naming; timestamps most informative for time-series |
| Pre-computed parameters | Recompute all from raw curves | Preserves ability to adjust FJ/FI timings, ensures consistency with existing pipeline, enables full derivative/spline analysis |
| Instrument metadata | Auto-populate interpretation & annotation forms | Reduces manual data entry, leverages data already in the file |
| Detection method | Client-side via FileReader | Avoids unnecessary server round-trip; keeps UX responsive |
| Multi-curve + single-curve mixing | Prevent (enforce single file mode when multi-curve detected) | Avoids naming conflicts and confusing UX |

---

## 6. Questions for Alexey (Monday Meeting)

### About the Multi-Curve File Format

1. **Is the file format consistent?** Does the FluorPen software always export multi-curve files in this exact format (header lines, index/time/id rows, data matrix, parameter footer)? Are there variations we should handle?

2. **Protocol types**: In the example, all curves have `id = OJIP`. Can the file contain mixed protocols (e.g., some OJIP, some Fv/Fm quick test, some QY)? If so, should we filter to only OJIP curves?

3. **Typical file sizes**: How many curves would a typical multi-curve file contain? Is 756 curves (spanning ~11 days) typical, or can files be much larger or smaller?

4. **Measurement interval**: The example has ~20-minute intervals. Is this configurable on the FluorPen? Can intervals be irregular (manual triggering vs. automated)?

5. **Background values**: The `Bckg` row — is this the detector dark signal? Is it already subtracted from the fluorescence values in the data rows, or are the data rows raw (including background)?

6. **Description field**: The `description` row is empty in the example. Can users add per-curve descriptions in the FluorPen software? Would these be useful for curve naming/identification?

7. **AquaPen vs FluorPen**: Does the AquaPen produce multi-curve files in the same format? Or is this format specific to FluorPen?

### About Alexey's Use Case

8. **What is the experimental setup?** Is this from greenhouse monitoring (tomato plants, as mentioned in emails)? Understanding the use case helps optimize the selection UI and grouping.

9. **How does Alexey currently work with these files?** Does he split them manually? Use another tool? Export to Excel?

10. **Which curves matter?** When analyzing 756 curves from an 11-day experiment, does Alexey typically want:
    - All curves (time-series analysis)?
    - Specific time windows (e.g., before/after treatment)?
    - Subsampled curves (e.g., every Nth)?
    - Specific curves selected by condition/treatment?

11. **Grouping needs**: For the Groups & Averages feature — how would Alexey want to group curves from a time-series? By date? By treatment phase? By time of day?

12. **Curve naming preference**: Which naming scheme would be most useful — timestamps (for time-series context), sequential indices, or filename-based names?

### About IT Security / Corporate Network Issues

13. **Upload/download blocking**: Alexey mentioned IT security policies block drag-and-drop and uploads. Is this specific to his work PC browser, or a network-level restriction?
    - Could a different upload mechanism help (e.g., paste file path, or a local desktop app)?
    - Would processing the file entirely client-side (no server upload) bypass the restriction?
    - Does the `arden` corporate network upload route (already implemented) help?

14. **Teams demo**: For the Monday demo, should we prepare specific files or scenarios? Would it help to have Alexey's actual FluorPen files ready?

### About Future Directions / ML Context

15. **Annotation completeness**: For the ML training dataset goal — does the multi-curve file's embedded metadata (timestamps, instrument settings) cover what's needed, or are there additional annotations Alexey would want per curve (e.g., treatment conditions, leaf age, watering status)?

16. **Time-series visualization**: Beyond standard OJIP analysis per curve, would it be valuable to add a time-series view showing how specific JIP parameters (e.g., Fv/Fm, VJ) change across the 756 measurements over time? This could be a future feature.

17. **Batch export**: For ML pipeline integration — does Alexey need a specific export format? The current tool exports XLSX and annotated ZIP bundles. Would CSV/Parquet per-parameter time-series be useful?

---

## 7. Email Context Summary

### Conversation Timeline

- **June 29**: Tomas shared cyano.tools OJIP tool with Alexey after meeting at IPAP conference. Discussed ML models for OJIP prediction, annotation standards (MIAPPE, ISA-Tab), and the importance of proper metadata for training datasets.

- **July 8**: Tomas announced the annotation tool version at cyano.tools/OJIP_data_analysis.

- **July 9 (AM)**: Alexey reported upload issues — drag-and-drop opens file in new browser tab, "click to browse" inactive. Suspected IT security blocking. Requested Teams demo.

- **July 9 (PM)**: Tomas made an update to potentially resolve upload issues. Sent AquaPen example files. Proposed Monday 4 PM CET meeting.

- **July 10 (AM)**: Alexey confirmed tool works on home PC, including with **leaf FluorPen raw kinetics files**. Reported that **only the first CF column is analyzed** from multi-curve files. Asked if multiple kinetics can be analyzed from one file. Confirmed Monday 4 PM works. Will send Teams invite and add Sylvain.

- **July 10**: This planning session — analyzed multi-curve file format and designed implementation plan.

### Key People

- **Tomas Zavrel** (CzechGlobe) — Tool developer
- **Alexey Shapiguzov** (University of Helsinki / LUKE) — User testing with FluorPen leaf data, interested in ML applications
- **Sylvain** — May join Monday meeting (added by Alexey)
- **Anna Matuszynska** — Collaborator on OJIP ML modeling
- **Jan Cerveny** — PI, collaborating with UTS on predictive ML models
