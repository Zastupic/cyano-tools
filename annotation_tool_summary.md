# Fluorescence Annotation Tool — Functional Summary

## Overview

The fluorescence annotation tool is a metadata annotation system for OJIP (chlorophyll fluorescence) measurements. It creates MIAPPE 1.1-compliant, ML-ready datasets by combining raw fluorescence transient data with comprehensive experimental metadata. The system operates on a hierarchical four-tier model: Investigation → Study → Fluorometer → Per-Curve.

**Architecture:** Flask blueprint (Python backend) + IIFE JavaScript module (frontend) + multi-tab HTML forms (shared partial template).

**Key files:**
- `website/fluorescence_annotation.py` — Backend: file parsing, JIP computation, bundle serialisation, XLSX generation, NCBI proxy
- `website/static/js_fluorescence_annotation.js` — Frontend: form management, grid rendering, inline editing, drag-drop
- `website/templates/_ann_tier_forms.html` — Shared form tabs (5 tabs: Project, Experiment, Treatment, Fluorometer, Filename tokens)
- `website/templates/OJIP_analysis.html` — Integration point (annotation tab within OJIP analysis page)

---

## Data Tier Hierarchy

```
Investigation (once per project)
  └→ project_title, contact_name, contact_email, institution, license, description

Study (once per experiment)
  ├→ Biological identity: organism (NCBI search), genotype, sub_strain_cultivar
  ├→ Growth conditions: light intensity/type/spectrum, temperature, CO₂, photoperiod
  └→ Sample-type–specific:
      ├→ Liquid culture: medium, pH, buffer, trophic mode, cultivator, cultivation mode, density
      ├→ Vascular plant: growth facility, substrate, pot size, watering, dev stage
      └→ Detached leaf: leaf position, surface, age

Fluorometer (shared acquisition protocol)
  ├→ Instrument (auto-detected from file format)
  ├→ Saturating pulse: intensity, wavelength, duration
  ├→ Measuring light: intensity, wavelength
  ├→ Detector: gain, damping, bandpass filter, sample holder, stirring
  └→ Dark pre-acclimation: duration, actinic light, temperature, CO₂

Per-Curve (repeats per file)
  ├→ Identity: curve_id (SHA256), filename, sample_id
  ├→ Treatment: label + chemical/stress/other sub-fields (template-assignable)
  ├→ Conditions: temperature, CO₂, vessel, growth phase (per-curve overrides)
  ├→ Replicates & QC: bio_rep, tech_rep, batch_id, quality flag
  └→ Computed: 24 JIP parameters (F0, FM, Fv/Fm, VJ, VI, M0, etc.)
```

**Total fields:** ~157 (7 investigation + ~50 study + ~25 fluorometer + ~75 per-curve)

---

## Backend API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/fluorescence_annotation` | GET | Render standalone annotation page |
| `/api/fluorescence_annotation/schema` | GET | Return FIELDS dict as JSON |
| `/api/fluorescence_annotation/ingest` | POST | Parse raw .csv/.txt files → grid rows with JIP params |
| `/api/fluorescence_annotation/ingest_from_ojip` | POST | Build rows from pre-computed OJIP results (no file re-parsing) |
| `/api/fluorescence_annotation/export` | POST | Grid rows + tier defaults → ZIP bundle |
| `/api/fluorescence_annotation/load_bundle` | POST | Unpack ZIP bundle → restore grid state |
| `/api/fluorescence_annotation/xlsx_template` | POST | Generate multi-sheet XLSX template (blank or pre-filled) |
| `/api/fluorescence_annotation/xlsx_upload` | POST | Parse filled XLSX → tier dicts + per-curve overrides |
| `/api/fluorescence_annotation/ncbi_taxon` | GET | Typeahead search against NCBI Taxonomy API |

---

## Key Features

### 1. Provenance Tracking
Every cell carries source metadata visible as coloured border stripes and corner glyphs:
- **T (Typed)** — blue: manually entered by user
- **H (from_header)** — green: extracted from file header
- **F (from_filename)** — yellow: parsed from filename tokens
- **I (Inherited)** — grey: propagated from study/fluorometer tier
- **C (Computed)** — purple: auto-calculated (curve_id, JIP params, completeness)

### 2. Hierarchical Inheritance
Study and Fluorometer tier metadata automatically propagates to all per-curve rows. Any inherited value can be overridden per-row in the grid.

### 3. Conditional Field Visibility
Form fields and grid columns show/hide dynamically based on sample_type:
- `liquid culture` → medium, pH, buffer, cultivator, trophic mode, density fields
- `vascular plant` → growth facility, substrate, pot size, dev stage, plant organ
- `detached leaf / disc` → leaf position, surface, age

### 4. Treatment Templates
Reusable treatment groups defined in the Treatment tab (chemical, stress, other). Assigning a `treatment_label` to a grid row auto-populates all matching sub-fields (dose, unit, duration, detail).

Three template categories:
- **Chemical:** DCMU, methyl viologen, KCN, hydroxylamine, atrazine, etc.
- **Stress:** high/low light, heat, cold, UV-B, nitrogen/phosphorus/sulfur/iron starvation, salt, drought
- **Other:** free-form

### 5. Filename Token Parsing
Positional, separator-delimited extraction of metadata from file names:
- Configurable separator (default: `_`)
- Per-position field mapping (sample_id, treatment_label, timepoint, bio_rep, etc.)
- Optional `vocab_map` for abbreviation expansion (e.g., `HL` → `high_light`)
- Optional `strip_prefix` / `strip_suffix` for cleaning (e.g., `rep3` → `3`)

### 6. NCBI Organism Lookup
Live typeahead search in the Organism field:
- Immediate filtering of 8 preset organisms (cyanobacteria, algae, model plants)
- Debounced NCBI Entrez API call (esearch + esummary) for 3+ characters
- On XLSX upload: auto-resolve organism name via token-based scoring against presets + NCBI, with colour-coded match badge (green ≥80%, yellow 50–79%, red <50%)

### 7. Completeness Scoring
Per-row score: `100 × (filled cells / relevant cells)`. Displayed as a colour-coded mini-bar:
- Green: ≥ 80%
- Amber: 50–79%
- Red: < 50%

Excludes investigation tier fields and conditional fields not matching the current sample_type.

### 8. Empty-Field Highlighting
All unfilled form fields across all tier tabs (Project, Experiment, Treatment, Fluorometer) display a light-red background (`#fff0f0`). The highlight clears in real-time as the user types. Applies to dynamically added treatment rows as well.

### 9. JIP Parameter Computation
24 OJIP kinetic parameters computed per curve:

| Parameter | Meaning |
|-----------|---------|
| F0, FM | Min/max fluorescence |
| FK, FJ, FI | Fluorescence at 300 µs, J-step, I-step |
| VJ, VI | Normalised relative variable fluorescence |
| Fv/Fm | Maximum PSII quantum yield |
| M0 | Initial slope of fluorescence rise |
| psiE0, psiR0 | Electron transport probabilities |
| phiE0, phiR0 | Quantum yields of electron transport |
| ABS/RC, TR0/RC, ET0/RC, RE0/RC, DI0/RC | Specific energy fluxes per reaction centre |
| Area_OJ, Area_JI, Area_IP, Area_OP | Complementary areas between phases |
| Sm, N | Normalised area, turnover number |

### 10. Instrument Auto-Detection

| File pattern | Detected instrument |
|---|---|
| .csv with "time/ms" header | MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH) |
| .txt matching AquaPen/FluorPen regex | AquaPen / FluorPen (PSI) |
| .txt matching FL6000 regex | FL6000 (PSI) |

---

## XLSX Template System

### Download (two modes)
- **Blank template** (`annotation_template.xlsx`): empty multi-sheet workbook with dropdown validations — always available
- **Pre-filled template** (`annotation_template_prefilled.xlsx`): same structure but cells populated from current form values — enabled only when metadata fields contain data

### Workbook structure
Sheets are auto-generated from the HTML form layout (`_extract_form_layout()`):
1. **Project** — Investigation tier fields
2. **Experiment-common** — Shared study fields (biological identity, growth conditions)
3. **Experiment-liquid culture** — Liquid culture–specific fields
4. **Experiment-vascular plant** — Plant-specific fields
5. **Experiment-detached leaf** — Leaf-specific fields
6. **Fluorometer** — Instrument and protocol settings
7. **Chem./Stress/Other treatments** — Treatment template rows
8. **_Vocab** (hidden) — Large dropdown lists exceeding Excel's 255-char inline limit

### Upload
Parses filled XLSX back into tier dicts + treatment templates. Auto-resolves organism name against presets and NCBI Taxonomy.

---

## Export Bundle (ZIP)

Contents:
| File | Purpose |
|------|---------|
| `state.json` | Full application state (all tiers, rows with provenance, token dict, templates) |
| `MANIFEST.json` | Bundle identity, counts, schema version |
| `annot/<curve_id>.json` | Per-curve sidecar with full metadata |
| `summary.parquet` (or `.csv`) | Flattened one-row-per-curve table for ML pipelines |
| `files/<filename>.csv` | Raw OJIP transient time-series (optional) |

---

## OJIP Analysis Integration

The annotation tool integrates as a tab within the OJIP analysis page (`OJIP_analysis.html`):

1. User uploads and analyses OJIP files (separate OJIP analysis module)
2. User fills in experiment metadata in the annotation tier forms
3. **"Populate annotation grid"** button sends pre-computed OJIP results to `/api/fluorescence_annotation/ingest_from_ojip` — no file re-parsing needed
4. Grid populates with one row per curve, inheriting tier metadata + JIP parameters
5. User can edit cells inline, assign treatment templates, adjust per-curve overrides
6. **"Download annotated bundle"** exports the complete ZIP archive

---

## Grid UI

### Column Groups (colour-coded)
| Group | Colour | Contents |
|-------|--------|----------|
| Identity | dark teal | curve_id, filename, sample_id |
| Biological | teal | organism, genotype, sub_strain_cultivar |
| Treatment | purple | treatment_label, chemical/stress/other sub-fields, timepoint |
| Conditions | cyan | temperature, CO₂, vessel, growth phase, density |
| Replicate/QC | amber | bio_rep, tech_rep, batch_id, quality |
| Acquisition | blue | instrument, gain, timestamp, JIP parameters |

### Toolbar
- **Search:** filter rows by filename, sample_id, treatment_label, organism, genotype
- **Filters:** incomplete-only (score < 80%), provenance filter, sort order
- **Group toggles:** show/hide Conditions, Replicate/QC column groups
- **Fill-down:** copy first row's value to all visible rows in a column

### Inline Editing
- Click editable cell → inline input or dropdown (vocab-driven)
- Enter → commit + move down; Tab → commit + move right; Escape → cancel
- All manual edits set provenance to "typed"

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3, Flask, pandas, numpy, openpyxl, pyarrow |
| Frontend | Vanilla JavaScript (IIFE module), Bootstrap 4, Font Awesome 4, SheetJS |
| Data formats | JSON, XLSX, Parquet, CSV, ZIP |
| External APIs | NCBI Entrez (esearch + esummary for taxonomy) |

**Schema version:** 2.0.0
**MIAPPE alignment:** Investigation, Study, and per-curve tiers map to MIAPPE 1.1 + MICF extensions for instrument-specific metadata
