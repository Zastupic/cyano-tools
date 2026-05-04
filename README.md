# CyanoTools

[![Website](https://img.shields.io/badge/Website-cyano.tools-blue)](https://www.cyano.tools/)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen)](#)
[![Stack](https://img.shields.io/badge/Stack-Python%20|%20Flask-lightgrey)](https://www.pythonanywhere.com/)

**CyanoTools** is a collection of open-access, web-based computational tools designed for researchers working with photosynthetic microorganisms, algae, and plants. Developed by the **Department of Adaptive Biotechnologies (DoAB)** at the Global Change Research Institute of the Czech Academy of Sciences, it provides high-performance analysis for fluorescence, microscopic, and spectroscopic data.

## 🚀 Key Features
- **Research-Focused:** Tailored for cyanobacterial and algal biology.
- **Batch Processing:** Support for up to 50 files simultaneously with summary `.xlsx` exports.
- **Privacy First:** Data is processed in-session or temporarily and is never retained or shared.
- **No Installation:** Runs entirely in the browser across desktops, tablets, and phones.

---

## 🛠️ Analytical Tools Overview

### 1. Chlorophyll Fluorescence Analysis
Comprehensive processing for PAM (Pulse-Amplitude-Modulation) fluorometry data.
- **OJIP Curves:** - Automatic shifting and normalization (F₀ to Fₚ).
  - Inflection point identification (J, I, P) using 2nd derivation.
  - Calculation of efficiency parameters for PSII and electron transport.
- **Rapid Light Curves (RLC):** - Fitting curves using the Platt et al. (1980) equation.
  - Parameter calculation (ETRmax, α, Ek) and automated plotting.
- **Slow (Kautsky) Kinetics:** - Analysis of induction kinetics, NPQ relaxation, and state transitions.
  - Calculates QY, rETR, qP, qN, and NPQ.

### 2. Microscopy & Image Analysis
Optimized for fluorescence and confocal microscopy images.
- **Cell Counting:** - **Round Cells:** Automated detection and counting.
  - **Filamentous Strains:** Automated filament segmentation into individual cells.
- **Cell Size Estimation:** - Manual selection with automated size determination and histogram generation.
- **Pixel/Pigment Profiles:** - Analyzes fluorescence intensity across cellular cross-sections.
  - Supports multi-channel overlays (up to 4 channels) to study intracellular pigment distribution.

### 3. Spectrofluorometry
Analysis of 3D Excitation-Emission Matrices (EEM).
- **Pigment Composition:** Supports strains with Chlorophyll, Phycocyanin, and Phycoerythrin.
- **Energy Transfer:** Calculates ratios for PSII/PSI and antenna attachment.
- **Normalization:** Custom selection of excitation/emission wavelengths for spectrum normalization.

### 4. Specialized Tools
- **MIMS (Membrane Inlet Mass Spectrometry):** Visualization and normalization of dissolved gases (O₂, CO₂, H₂, CH₄).
- **Photobioreactors:** Specific growth rate analysis for batch and turbidostat experiments (e.g., FMT-150).
- **Calculators:** Tools for CO₂/O₂ solubility, OD₇₂₀ non-linearity correction, and device-to-device OD recalibration.

---

## 📱 Supported Devices & Formats

| Category | Supported Devices | File Formats |
| :--- | :--- | :--- |
| **Fluorometers** | Walz (Multi-Color PAM, Dual PAM), PSI (AquaPen, FluorPen, FL 6000) | `.csv`, `.txt` |
| **Microscopes** | Any Confocal or Fluorescence Microscope | `.png`, `.jpg`, `.tif`, `.bmp`, `.gif` |
| **Spectrofluorometers** | Jasco (FP-8050 Series and others) | `.csv` |
| **MIMS** | Hiden HPR-40, MS GAS | `.csv`, `.asc` |
| **Photobioreactors** | PSI (FMT-150) | `.xlsx` |

---

## 📂 Project Structure
The website is built on the **Python Flask** framework and hosted on PythonAnywhere.
```text
Flask_server/
└── Website/
    ├── static/          # CSS, JS, and image assets
    │   ├── images/      # UI icons and graphics
    │   ├── files/       # Sample data files
    │   └── uploads/     # Temporary user data handling
    ├── templates/       # HTML Jinja2 templates
    └── *.py             # Backend logic for individual analytical tools
