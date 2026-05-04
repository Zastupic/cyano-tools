# CyanoTools

[![Website](https://img.shields.io/badge/Website-cyano.tools-blue)](https://www.cyano.tools/)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen)](#)
[![Stack](https://img.shields.io/badge/Stack-Python%20|%20Flask-lightgrey)](https://www.pythonanywhere.com/)

**CyanoTools** is a free, browser-based platform we built for researchers working with cyanobacteria, microalgae, and plants. It grew out of our everyday lab needs at the **Department of Adaptive Biotechnologies (DoAB)**, Global Change Research Institute, Czech Academy of Sciences — we kept writing the same analysis scripts over and over, so we turned them into proper tools anyone can use without installing anything.

The platform covers PAM fluorometry, fluorescence spectroscopy, membrane inlet mass spectrometry, microscopy image analysis, metabolic modelling, statistics, and a handful of calculators that save time during routine wet-lab work. Raw instrument files go in, publication-ready results come out.

---

## What makes it useful

- **No installation, no account** — open a browser, upload a file, get results. Works on phones and tablets too.
- **Batch processing** — up to 50 files at once, results exported as `.xlsx`.
- **Privacy by design** — data is processed in-session and never stored on our servers.
- **Instrument-aware** — parsers handle the quirky formats from Walz, PSI, Jasco, Hiden, and others directly.
- **Transparent methods** — every tool includes the equations and parameter definitions it uses, so you know exactly what the numbers mean.

---

## Tools

### PAM Fluorometry

The fluorometry module handles data from Walz (Multi-Color PAM, Dual-PAM) and PSI instruments (AquaPen, FluorPen, FL 6000), accepting `.csv` and `.txt` files.

**OJIP transients** — Polyphasic fluorescence rise curves. The tool shifts and normalises traces automatically (F₀ → Fₘ), locates J, I, and P inflection points via second-derivative analysis, and calculates JIP-test parameters describing PSII efficiency and electron transport chain performance.

**Rapid Light Curves (RLC / PI curves)** — Fits curves to the Platt et al. (1980) equation and extracts ETRmax, α, and Ek for each sample. Plots are generated automatically and results exported together.

**Kautsky (slow) kinetics** — Full induction kinetics including NPQ relaxation and state transitions. Outputs QY, rETR, qP, qN, NPQ, and related parameters across the measurement timeline.

**Sigma(II) — absorption cross-section** — Calculates the wavelength-dependent functional absorption cross-section of Photosystem II, useful for comparing antenna sizes across strains or acclimation states.

---

### Fluorescence Spectroscopy

Designed for Jasco spectrofluorometers (`.csv`). Works with both 77 K and room-temperature measurements.

**Fluorescence Spectra & EEM Analyzer** — Processes excitation-emission matrices and individual spectra to assess pigment-protein complex composition, PSII/PSI stoichiometry, and antenna attachment efficiency. Custom excitation/emission wavelengths can be selected for normalisation. Covers strains containing chlorophyll, phycocyanin, and phycoerythrin.

---

### Membrane Inlet Mass Spectrometry (MIMS)

Supports Hiden HPR-40 (`.csv`) and PSI MS GAS (`.asc`) instruments.

**MIMS module** — Visualises dissolved and gas-phase analyte dynamics (O₂, CO₂, H₂, CH₄, and others) and applies normalisation to correct for instrument drift and baseline shift. Useful for photosynthesis/respiration measurements and gas exchange experiments.

---

### Microscopy & Image Analysis

Accepts standard image formats: `.png`, `.jpg`, `.tif`, `.bmp`, `.gif`. Works with any fluorescence or brightfield microscope output.

**Cell counting – round cells** — Automated detection and counting of spherical/coccoid cells in fluorescence images.

**Cell counting – filaments** — Automated filament segmentation that counts individual cells within filamentous chains.

**Cell size – round cells** — Automated diameter estimation with histogram output.

**Cell size – filaments** — Manual cell selection with automated size determination for filamentous morphologies.

**Pigment profiles – round cells** — Fluorescence intensity across cellular cross-sections for up to 4 channels simultaneously, showing intracellular pigment distribution in single cells.

**Pigment profiles – filaments** — Same cross-section analysis adapted for filamentous strains.

---

### Photobioreactors

**PSI PBR data analysis** — Growth rate analysis for FMT-150 photobioreactors running batch, turbidostat, or periodic regimes. Accepts `.xlsx` exports from the FMT-150. Hosted as a standalone Shiny app.

**PSI PBR control scripts** — A library of FMT-150 control scripts including a growth optimizer and PI curve measurement protocol.

---

### Modelling

**Metabolic Model** — Flux balance analysis (FBA) of *Synechocystis* sp. PCC 6803. Supports light sweep simulations and growth modelling directly in the browser.

**E-cyanobacterium** — A companion platform for sharing, annotating, and comparing metabolic models alongside wet-lab experimental data. Hosted separately at [e-cyanobacterium.org](https://www.e-cyanobacterium.org/).

---

### Statistics

**Statistical analysis** — ANOVA with pairwise comparisons, normality tests, correlation analysis, PCA, and boxplot visualisation. Designed for typical experimental datasets from photosynthesis research without requiring R or Python knowledge.

---

### Calculators

A set of quick calculators for common lab conversions and corrections:

- Dissolved O₂ and CO₂ solubility
- OD₇₂₀ non-linearity correction
- Device-to-device OD recalibration
- Culture doubling time
- Dissolved inorganic carbon (DIC) speciation in seawater/freshwater

---

## Supported instruments and file formats

| Category | Instruments | Formats |
| :--- | :--- | :--- |
| **PAM fluorometers** | Walz Multi-Color PAM, Dual-PAM; PSI AquaPen, FluorPen, FL 6000 | `.csv`, `.txt` |
| **Spectrofluorometers** | Jasco FP-8050 series and compatible | `.csv` |
| **MIMS** | Hiden HPR-40, PSI MS GAS | `.csv`, `.asc` |
| **Photobioreactors** | PSI FMT-150 | `.xlsx` |
| **Microscopy** | Any fluorescence or confocal microscope | `.png`, `.jpg`, `.tif`, `.bmp`, `.gif` |

---

## How to cite

> CyanoTools – a web-based toolkit for cyanobacteria, algae, and plant research. Available at: https://www.cyano.tools/

---

## Project structure

The site runs on **Python Flask**, hosted on PythonAnywhere.

```text
Flask_server/
└── Website/
    ├── static/          # CSS, JS, and image assets
    │   ├── images/      # UI icons and graphics
    │   ├── files/       # Sample data files
    │   └── uploads/     # Temporary user upload handling
    ├── templates/       # HTML Jinja2 templates
    └── *.py             # Backend analysis logic, one module per tool
```

---

## About

CyanoTools is developed and maintained by the [Department of Adaptive Biotechnologies (DoAB)](https://www.czechglobe.cz/en/institute-structure/research-sector/v-domain-adaptive-and-innovative-techniques/department-of-adaptive-biotechnologies/) at the [Global Change Research Institute](https://www.czechglobe.cz/en/), Czech Academy of Sciences.

If you run into a bug, have a feature request, or want to contribute a parser for an instrument we don't support yet, open an issue — we're happy to hear from other labs.
