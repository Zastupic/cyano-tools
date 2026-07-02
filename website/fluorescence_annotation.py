"""
fluorescence_annotation.py — Fluorescence Data Annotation Tool (M1 back-end core).

Blueprint: /fluorescence_annotation  (GET — UI page)
           /api/fluorescence_annotation/schema       (GET  — field schema for JS)
           /api/fluorescence_annotation/ingest       (POST — parse files → grid rows)
           /api/fluorescence_annotation/export       (POST — grid rows → ZIP bundle)
           /api/fluorescence_annotation/load_bundle  (POST — ZIP → grid state)

Design:
  - Four metadata tiers (Investigation / Study / Assay / Per-curve) with inheritance.
  - Each field cell carries a provenance flag: typed | from_header | from_filename |
    inherited | computed.
  - Existing parsers (_ms_factor, _detect_fluorometer, _parse_transient) and JIP-test
    computation (_compute_jip_params → calls ojip_interpretation.interpret_ojip) are
    implemented here as private helpers; OJIP_data_analysis.py is not modified.
  - Bundle format: ZIP containing state.json + dataset.parquet + MANIFEST.json.
  - Parquet requires pyarrow; a CSV fallback is used when pyarrow is absent.
  - Raw transients are held in a temp JSON file in static/uploads/ (same 30-min
    cleanup daemon as the rest of the app) between /ingest and /export calls.

Run  `python website/fluorescence_annotation.py`  for a smoke test.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import uuid
import zipfile
from dataclasses import dataclass, field as dc_field
from typing import Any

import numpy as np
import pandas as pd
from flask import Blueprint, jsonify, render_template, request
from werkzeug.utils import secure_filename

SCHEMA_VERSION = "1.0.0"

# ── Provenance flag constants ─────────────────────────────────────────────────
TYPED         = "typed"
FROM_HEADER   = "from_header"
FROM_FILENAME = "from_filename"
INHERITED     = "inherited"
COMPUTED      = "computed"


# ── Field registry ────────────────────────────────────────────────────────────

@dataclass
class FieldDef:
    tier:      str              # investigation | study | assay | per_curve
    required:  str              # mandatory | recommended | optional | conditional
    dtype:     str              # str | float | int
    label:     str = ""
    vocab:     list = dc_field(default_factory=list)
    condition: str = ""         # e.g. "measurement_type == 'PAM'"
    miappe:    str = ""         # MIAPPE 1.1 / MICF mapping
    weight:    float = 0.0      # completeness scoring (0 = not scored)


FIELDS: dict[str, FieldDef] = {

    # ── Investigation (once per project) ─────────────────────────────────────
    "project_title":       FieldDef("investigation", "mandatory",    "str",
                                    "Project title", weight=3.0,
                                    miappe="Investigation title"),
    "contact_name":        FieldDef("investigation", "recommended",  "str",
                                    "Contact name", weight=1.0,
                                    miappe="Investigation person name"),
    "contact_email":       FieldDef("investigation", "recommended",  "str",
                                    "Contact e-mail", weight=1.0,
                                    miappe="Investigation person email"),
    "institution":         FieldDef("investigation", "recommended",  "str",
                                    "Institution", weight=1.0,
                                    miappe="Investigation person affiliation"),
    "license":             FieldDef("investigation", "optional",     "str",
                                    "Licence",
                                    vocab=["CC-BY-4.0", "CC-BY-NC-4.0", "CC0-1.0", "Proprietary"],
                                    miappe="License"),
    "project_description": FieldDef("investigation", "optional",     "str",
                                    "Description", miappe="Investigation description"),

    # ── Study (once per experiment) ───────────────────────────────────────────
    "organism":            FieldDef("study", "mandatory", "str", "Organism",
                                    vocab=["Synechocystis sp. PCC 6803",
                                           "Synechococcus sp. PCC 7942",
                                           "Anabaena sp. PCC 7120",
                                           "Thermosynechococcus elongatus BP-1",
                                           "Chlamydomonas reinhardtii",
                                           "Chlorella vulgaris",
                                           "Arabidopsis thaliana",
                                           "Spinacia oleracea", "Other"],
                                    weight=3.0, miappe="Organism"),
    "taxonomic_group":     FieldDef("study", "mandatory", "str", "Taxonomic group",
                                    vocab=["Cyanobacteria", "Green alga", "Diatom",
                                           "Red alga", "Plant", "Other"],
                                    weight=3.0, miappe="Organism"),
    "strain":              FieldDef("study", "recommended", "str", "Strain",
                                    weight=1.0, miappe="Biological material source ID"),
    "culture_collection_id": FieldDef("study", "optional", "str", "Culture collection ID",
                                    miappe="Biological material source DOI"),
    "growth_medium":       FieldDef("study", "recommended", "str", "Growth medium",
                                    weight=1.0, miappe="Growth facility"),
    "growth_conditions":   FieldDef("study", "optional",     "str", "Growth conditions",
                                    miappe="Growth condition"),
    "dark_adaptation_min": FieldDef("study", "recommended", "float",
                                    "Dark adaptation (min)", weight=1.0,
                                    miappe="MICF:darkAdaptationDuration"),
    "instrument":          FieldDef("study", "mandatory", "str", "Instrument",
                                    vocab=["MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
                                           "Aquapen", "FL6000"],
                                    weight=3.0, miappe="MICF:instrumentModel"),
    "measuring_light_wavelength_nm":  FieldDef("study", "recommended", "float",
                                    "Measuring light wavelength (nm)", weight=1.0,
                                    miappe="MICF:measuringLightWavelength"),
    "measuring_light_intensity_umol": FieldDef("study", "recommended", "float",
                                    "Measuring light intensity (µmol m⁻² s⁻¹)", weight=1.0,
                                    miappe="MICF:measuringLightIntensity"),
    "actinic_light_wavelength_nm":    FieldDef("study", "optional", "float",
                                    "Actinic light wavelength (nm)",
                                    miappe="MICF:actinicLightWavelength"),
    "actinic_light_intensity_umol":   FieldDef("study", "optional", "float",
                                    "Actinic light intensity (µmol m⁻² s⁻¹)",
                                    miappe="MICF:actinicLightIntensity"),
    "saturating_pulse_intensity_umol": FieldDef("study", "conditional", "float",
                                    "Sat. pulse intensity (µmol m⁻² s⁻¹)",
                                    condition="measurement_type == 'PAM'", weight=1.0,
                                    miappe="MICF:saturatingPulseIntensity"),
    "saturating_pulse_duration_ms":   FieldDef("study", "conditional", "float",
                                    "Sat. pulse duration (ms)",
                                    condition="measurement_type == 'PAM'", weight=1.0,
                                    miappe="MICF:saturatingPulseDuration"),

    # ── Assay (per measurement type) ─────────────────────────────────────────
    "measurement_type":    FieldDef("assay", "mandatory", "str", "Measurement type",
                                    vocab=["OJIP", "PAM_induction", "RLC", "P700", "Sigma"],
                                    weight=3.0, miappe="Observation unit type"),
    "assay_description":   FieldDef("assay", "optional", "str", "Assay description",
                                    miappe="Study design description"),

    # ── Per-curve (repeats per file) ──────────────────────────────────────────
    "curve_id":            FieldDef("per_curve", "mandatory", "str", "Curve ID",
                                    weight=3.0, miappe="MICF:curveID"),
    "filename":            FieldDef("per_curve", "mandatory", "str", "Filename",
                                    weight=3.0),
    "sample_id":           FieldDef("per_curve", "recommended", "str", "Sample ID",
                                    weight=1.0, miappe="Sample name"),
    "replicate_id":        FieldDef("per_curve", "recommended", "int", "Replicate #",
                                    weight=1.0, miappe="Biological replicate"),
    "treatment":           FieldDef("per_curve", "recommended", "str", "Treatment",
                                    vocab=["control", "high_light", "low_light",
                                           "heat", "cold", "drought", "salt", "dark",
                                           "CO2_limitation", "nitrogen_starvation",
                                           "phosphorus_starvation", "other"],
                                    weight=1.0, miappe="Factor value"),
    "treatment_dose":      FieldDef("per_curve", "optional", "float", "Treatment dose",
                                    miappe="Factor value"),
    "treatment_dose_unit": FieldDef("per_curve", "optional", "str",  "Dose unit",
                                    miappe="Factor unit"),
    "OD_at_measurement":   FieldDef("per_curve", "optional", "float",
                                    "OD at measurement", miappe="Sample description"),
    "timepoint_h":         FieldDef("per_curve", "recommended", "float", "Timepoint (h)",
                                    weight=1.0, miappe="Observation unit factor value"),
    "timestamp":           FieldDef("per_curve", "optional", "str",  "Timestamp",
                                    miappe="MICF:acquisitionTimestamp"),
    "gain":                FieldDef("per_curve", "optional", "float", "Gain",
                                    miappe="MICF:gain"),

    # ── Computed JIP parameters (provenance = COMPUTED, weight = 0) ───────────
    "jip_F0":      FieldDef("per_curve", "optional", "float", "F0 (Fin)",          miappe="MICF:derivedParameter"),
    "jip_FM":      FieldDef("per_curve", "optional", "float", "FM (Fmax)",         miappe="MICF:derivedParameter"),
    "jip_FK":      FieldDef("per_curve", "optional", "float", "FK",                miappe="MICF:derivedParameter"),
    "jip_FJ":      FieldDef("per_curve", "optional", "float", "FJ",                miappe="MICF:derivedParameter"),
    "jip_FI":      FieldDef("per_curve", "optional", "float", "FI",                miappe="MICF:derivedParameter"),
    "jip_VJ":      FieldDef("per_curve", "optional", "float", "VJ",                miappe="MICF:derivedParameter"),
    "jip_VI":      FieldDef("per_curve", "optional", "float", "VI",                miappe="MICF:derivedParameter"),
    "jip_Fv_Fm":   FieldDef("per_curve", "optional", "float", "Fv/Fm",             miappe="MICF:derivedParameter"),
    "jip_M0":      FieldDef("per_curve", "optional", "float", "M0",                miappe="MICF:derivedParameter"),
    "jip_psiE0":   FieldDef("per_curve", "optional", "float", "\u03c8E0",          miappe="MICF:derivedParameter"),
    "jip_psiR0":   FieldDef("per_curve", "optional", "float", "\u03c8R0",          miappe="MICF:derivedParameter"),
    "jip_deltaR0": FieldDef("per_curve", "optional", "float", "\u03b4R0",          miappe="MICF:derivedParameter"),
    "jip_phiE0":   FieldDef("per_curve", "optional", "float", "\u03c6E0",          miappe="MICF:derivedParameter"),
    "jip_phiR0":   FieldDef("per_curve", "optional", "float", "\u03c6R0",          miappe="MICF:derivedParameter"),
    "jip_ABS_RC":  FieldDef("per_curve", "optional", "float", "ABS/RC",            miappe="MICF:derivedParameter"),
    "jip_TR0_RC":  FieldDef("per_curve", "optional", "float", "TR0/RC",            miappe="MICF:derivedParameter"),
    "jip_ET0_RC":  FieldDef("per_curve", "optional", "float", "ET0/RC",            miappe="MICF:derivedParameter"),
    "jip_RE0_RC":  FieldDef("per_curve", "optional", "float", "RE0/RC",            miappe="MICF:derivedParameter"),
    "jip_DI0_RC":  FieldDef("per_curve", "optional", "float", "DI0/RC",            miappe="MICF:derivedParameter"),
    "jip_Area_OJ": FieldDef("per_curve", "optional", "float", "Complementary area O-J", miappe="MICF:derivedParameter"),
    "jip_Area_JI": FieldDef("per_curve", "optional", "float", "Complementary area J-I", miappe="MICF:derivedParameter"),
    "jip_Area_IP": FieldDef("per_curve", "optional", "float", "Complementary area I-P", miappe="MICF:derivedParameter"),
    "jip_Area_OP": FieldDef("per_curve", "optional", "float", "Complementary area O-P", miappe="MICF:derivedParameter"),
    "jip_Sm":      FieldDef("per_curve", "optional", "float", "Sm (norm. area)",   miappe="MICF:derivedParameter"),
    "jip_N":       FieldDef("per_curve", "optional", "float", "N (QA turnover)",   miappe="MICF:derivedParameter"),

    # Scored last so it appears at the end of the grid
    "completeness_score":  FieldDef("per_curve", "optional", "float",
                                    "Completeness (%)"),
}


# ── Schema helpers ────────────────────────────────────────────────────────────

def get_schema_json() -> dict:
    """Serialise FIELDS to a plain dict suitable for jsonify / JS consumption."""
    return {
        "schema_version": SCHEMA_VERSION,
        "fields": {
            name: {
                "tier":      f.tier,
                "required":  f.required,
                "dtype":     f.dtype,
                "label":     f.label,
                "vocab":     f.vocab,
                "condition": f.condition,
                "miappe":    f.miappe,
                "weight":    f.weight,
            }
            for name, f in FIELDS.items()
        },
    }


def validate_row(row: dict) -> list[str]:
    """
    Validate field values in a grid row.
    Returns a list of human-readable issue strings (empty = valid).
    """
    issues: list[str] = []
    for field_name, fdef in FIELDS.items():
        cell = row.get(field_name)
        if not isinstance(cell, dict):
            continue
        val = cell.get("value")
        if val is None or val == "":
            continue
        if fdef.vocab and str(val) not in fdef.vocab:
            issues.append(
                f"{fdef.label or field_name}: '{val}' is not in "
                f"the allowed vocabulary {fdef.vocab}"
            )
        if fdef.dtype == "float":
            try:
                float(val)
            except (ValueError, TypeError):
                issues.append(f"{fdef.label or field_name}: expected a number, got '{val}'")
        elif fdef.dtype == "int":
            try:
                int(float(str(val)))
            except (ValueError, TypeError):
                issues.append(f"{fdef.label or field_name}: expected an integer, got '{val}'")
    return issues


def _completeness_score(row: dict) -> float:
    """
    Completeness score 0–100 based on non-null values for weighted fields.
    Never rejects a row; score is informational only.
    """
    total = earned = 0.0
    for field_name, fdef in FIELDS.items():
        if fdef.weight <= 0:
            continue
        total += fdef.weight
        cell = row.get(field_name)
        if isinstance(cell, dict) and cell.get("value") not in (None, "", []):
            earned += fdef.weight
    return round(100.0 * earned / total, 1) if total > 0 else 0.0


# ── Instrument helpers ────────────────────────────────────────────────────────

def _ms_factor(fluorometer: str) -> float:
    """Multiplier from native time unit to milliseconds."""
    if fluorometer == "Aquapen":
        return 0.001    # µs → ms
    if fluorometer == "FL6000":
        return 1000.0   # s  → ms
    return 1.0          # MULTI-COLOR-PAM already in ms


def _detect_fluorometer(filename: str, raw_bytes: bytes) -> str | None:
    """
    Auto-detect instrument from file extension and content.
    Mirrors the detection logic in OJIP_data_analysis.py.
    """
    ext = os.path.splitext(filename)[1].lower()
    try:
        head = raw_bytes[:2000].decode("utf-8", errors="replace")
    except Exception:
        return None

    if ext == ".csv":
        if "time/ms" in head:
            return "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"
    elif ext == ".txt":
        if re.search(r"AquaPen|FluorPen", head, re.IGNORECASE):
            return "Aquapen"
        if re.search(r"Fluorometer", head, re.IGNORECASE):
            return "FL6000"
    return None


# ── Transient parser ──────────────────────────────────────────────────────────

def _parse_transient(
    raw_bytes: bytes, filename: str, fluorometer: str
) -> tuple[pd.DataFrame, str, float]:
    """
    Parse a single fluorescence file to a two-column DataFrame [x_col, 'fluorescence'].
    Returns (df, x_col, ms_factor).
    Raises ValueError on unrecognised format or empty data.
    """
    ms = _ms_factor(fluorometer)

    if fluorometer == "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)":
        df = pd.read_csv(io.BytesIO(raw_bytes), sep=";", engine="python")
        if str(df.columns[0]) != "time/ms":
            raise ValueError(f"Expected 'time/ms' column, got '{df.columns[0]}'")
        df = (df.iloc[:, [0, 1]]
                .rename(columns={df.columns[1]: "fluorescence"})
                .apply(pd.to_numeric, errors="coerce")
                .dropna()
                .reset_index(drop=True))
        return df, "time/ms", ms

    elif fluorometer == "Aquapen":
        text = raw_bytes.decode("utf-8", errors="replace")
        rows = []
        for line in text.splitlines():
            parts = line.strip().split("\t")
            if len(parts) >= 2:
                try:
                    rows.append((int(parts[0]), float(parts[1])))
                except (ValueError, IndexError):
                    pass
        if len(rows) < 2:
            raise ValueError("No numeric data found in Aquapen/FluorPen file")
        df = pd.DataFrame(rows[1:], columns=["time_us", "fluorescence"])  # skip t=0
        return df, "time_us", ms

    elif fluorometer == "FL6000":
        text = raw_bytes.decode("utf-8", errors="replace")
        lines = text.splitlines()
        start = next(
            (i + 1 for i, ln in enumerate(lines) if ln.strip() == "Time"), None
        )
        if start is None:
            raise ValueError("'Time' header not found in FL6000 file")
        rows = []
        for line in lines[start:]:
            parts = line.strip().split("\t")
            if len(parts) >= 2:
                try:
                    rows.append((float(parts[0]), float(parts[1])))
                except (ValueError, IndexError):
                    pass
        if not rows:
            raise ValueError("No numeric data found in FL6000 file")
        df = pd.DataFrame(rows, columns=["time_s", "fluorescence"])
        return df, "time_s", ms

    else:
        raise ValueError(f"Unknown fluorometer: {fluorometer!r}")


def _downsample_transient(
    df: pd.DataFrame, x_col: str, ms_factor: float, max_points: int = 2000
) -> dict:
    """
    Downsample a transient DataFrame to at most max_points rows.
    Preserves the fast O→J region (t < 0.5 ms) at full resolution.
    Returns {'time_ms': [...], 'fluorescence': [...]}.
    """
    x_ms = df[x_col].astype(float) * ms_factor
    y    = df["fluorescence"].astype(float)

    if len(df) <= max_points:
        return {"time_ms": x_ms.tolist(), "fluorescence": y.tolist()}

    mask_fast = x_ms < 0.5
    df_fast = df[mask_fast]
    df_slow = df[~mask_fast]

    n_fast = min(len(df_fast), max_points // 4)
    n_slow = max_points - n_fast

    step_f = max(1, len(df_fast) // n_fast) if n_fast > 0 else 1
    step_s = max(1, len(df_slow) // n_slow) if n_slow > 0 else 1

    df_out = pd.concat([
        df_fast.iloc[::step_f],
        df_slow.iloc[::step_s],
    ]).reset_index(drop=True)

    x_out = df_out[x_col].astype(float) * ms_factor
    y_out = df_out["fluorescence"].astype(float)
    return {"time_ms": x_out.tolist(), "fluorescence": y_out.tolist()}


# ── JIP parameter computation ─────────────────────────────────────────────────

def _sf(v) -> float | None:
    """Safe float: returns None for NaN/Inf/non-numeric."""
    try:
        f = float(v)
        return None if (np.isnan(f) or np.isinf(f)) else round(f, 6)
    except Exception:
        return None


def _compute_jip_params(
    df: pd.DataFrame,
    x_col: str,
    ms_factor: float,
    FJ_time_ms: float = 2.0,
    FI_time_ms: float = 30.0,
) -> dict:
    """
    Compute core JIP-test parameters from a parsed transient.
    FJ_time_ms / FI_time_ms are in milliseconds.
    Returns a flat dict with jip_* keys matching FIELDS.
    All arithmetic mirrors OJIP_data_analysis.py; spline fitting is omitted
    (only scalar reference-point parameters are needed for metadata annotation).
    """
    if len(df) < 10:
        return {"jip_error": "too_few_points"}

    x = df[x_col].values.astype(float)
    y = df["fluorescence"].values.astype(float)
    mask = np.isfinite(x) & np.isfinite(y)
    x, y = x[mask], y[mask]

    if len(x) < 10:
        return {"jip_error": "too_few_valid_points"}

    def at_ms(t_ms: float) -> float:
        """Fluorescence value at time t_ms (converts ms → native unit)."""
        t_native = t_ms / ms_factor
        return float(y[np.argmin(np.abs(x - t_native))])

    def idx_at_ms(t_ms: float) -> int:
        t_native = t_ms / ms_factor
        return int(np.argmin(np.abs(x - t_native)))

    # F0: at 0.01 ms for Walz (pre-illumination baseline removed), at t≈0 for others
    F0 = at_ms(0.01) if ms_factor == 1.0 else float(y[0])
    FM = float(np.max(y))
    FV = FM - F0

    if FV <= 0:
        return {"jip_F0": _sf(F0), "jip_FM": _sf(FM), "jip_error": "FV_zero_or_negative"}

    # Reference-time fluorescence values (times are the same in ms for all instruments)
    F50 = at_ms(0.05)   # 50 µs in ms
    FK  = at_ms(0.3)    # 300 µs in ms
    FJ  = at_ms(FJ_time_ms)
    FI  = at_ms(FI_time_ms)

    VJ     = (FJ - F0) / FV
    VI     = (FI - F0) / FV
    Fv_Fm  = FV / FM
    M0     = 4.0 * (FK - F50) / FV

    psiE0   = 1.0 - VJ
    psiR0   = 1.0 - VI
    deltaR0 = psiR0 / psiE0 if psiE0 != 0 else None
    phiE0   = Fv_Fm * psiE0
    phiR0   = Fv_Fm * psiR0
    TR0RC   = M0 / VJ if VJ != 0 else None
    ABS_RC  = TR0RC / Fv_Fm if (TR0RC is not None and Fv_Fm != 0) else None
    ET0_RC  = TR0RC * psiE0 if TR0RC is not None else None
    RE0_RC  = TR0RC * psiR0 if TR0RC is not None else None
    DI0_RC  = (ABS_RC - TR0RC) if (ABS_RC is not None and TR0RC is not None) else None

    # Complementary areas (rectangle − trapezoid, time axis in ms)
    x_ms   = x * ms_factor
    FJ_idx = idx_at_ms(FJ_time_ms)
    FI_idx = idx_at_ms(FI_time_ms)
    FM_idx = int(np.argmax(y))

    def safe_area(x_seg, y_seg, height) -> float | None:
        if len(x_seg) < 2:
            return None
        rect = float(x_seg[-1] - x_seg[0]) * height
        trap  = float(np.trapezoid(y_seg, x_seg))
        return rect - trap

    Area_OJ = safe_area(x_ms[:FJ_idx + 1], y[:FJ_idx + 1], FM) if FJ_idx > 0 else None
    Area_JI = safe_area(x_ms[FJ_idx:FI_idx + 1], y[FJ_idx:FI_idx + 1], FM) if FI_idx > FJ_idx else None
    Area_IP = safe_area(x_ms[FI_idx:FM_idx + 1], y[FI_idx:FM_idx + 1], FM) if FM_idx > FI_idx else None
    Area_OP = safe_area(x_ms[:FM_idx + 1], y[:FM_idx + 1], FM) if FM_idx > 0 else None

    Sm = Area_OP / FV if (Area_OP is not None and FV != 0) else None
    N  = Sm * M0 / VJ if (Sm is not None and VJ != 0) else None

    return {
        "jip_F0":      _sf(F0),
        "jip_FM":      _sf(FM),
        "jip_FK":      _sf(FK),
        "jip_FJ":      _sf(FJ),
        "jip_FI":      _sf(FI),
        "jip_VJ":      _sf(VJ),
        "jip_VI":      _sf(VI),
        "jip_Fv_Fm":   _sf(Fv_Fm),
        "jip_M0":      _sf(M0),
        "jip_psiE0":   _sf(psiE0),
        "jip_psiR0":   _sf(psiR0),
        "jip_deltaR0": _sf(deltaR0),
        "jip_phiE0":   _sf(phiE0),
        "jip_phiR0":   _sf(phiR0),
        "jip_ABS_RC":  _sf(ABS_RC),
        "jip_TR0_RC":  _sf(TR0RC),
        "jip_ET0_RC":  _sf(ET0_RC),
        "jip_RE0_RC":  _sf(RE0_RC),
        "jip_DI0_RC":  _sf(DI0_RC),
        "jip_Area_OJ": _sf(Area_OJ),
        "jip_Area_JI": _sf(Area_JI),
        "jip_Area_IP": _sf(Area_IP),
        "jip_Area_OP": _sf(Area_OP),
        "jip_Sm":      _sf(Sm),
        "jip_N":       _sf(N),
    }


# ── Filename token parser ─────────────────────────────────────────────────────

def _parse_filename(stem: str, token_dict: dict) -> dict[str, tuple[Any, str]]:
    """
    Apply a positional token convention to a filename stem.
    Returns {field_name: (value, FROM_FILENAME)} for every matched token.

    token_dict schema:
      {
        "separator": "_",          # split character (default "_")
        "tokens": [
          {"position": 0, "field": "strain"},
          {"position": 1, "field": "treatment",
           "vocab_map": {"HL": "high_light", "LL": "low_light"}},
          {"position": 2, "field": "timepoint_h", "strip_suffix": "h"},
          {"position": 3, "field": "replicate_id", "strip_prefix": "rep"}
        ]
      }
    """
    if not token_dict or not token_dict.get("tokens"):
        return {}

    sep   = token_dict.get("separator", "_")
    parts = stem.split(sep)
    result: dict[str, tuple[Any, str]] = {}

    for tok in token_dict["tokens"]:
        pos = tok.get("position", -1)
        if not (0 <= pos < len(parts)):
            continue
        raw: Any = parts[pos]
        field_name = tok.get("field", "")
        if not field_name:
            continue

        if "vocab_map" in tok:
            raw = tok["vocab_map"].get(raw, raw)
        if "strip_suffix" in tok and isinstance(raw, str) and raw.endswith(tok["strip_suffix"]):
            raw = raw[: -len(tok["strip_suffix"])]
        if "strip_prefix" in tok and isinstance(raw, str) and raw.startswith(tok["strip_prefix"]):
            raw = raw[len(tok["strip_prefix"]) :]

        fdef = FIELDS.get(field_name)
        if fdef:
            if fdef.dtype == "float":
                try:
                    raw = float(raw)
                except (ValueError, TypeError):
                    pass
            elif fdef.dtype == "int":
                try:
                    raw = int(float(str(raw)))
                except (ValueError, TypeError):
                    pass

        result[field_name] = (raw, FROM_FILENAME)

    return result


# ── Tier inheritance ──────────────────────────────────────────────────────────

def _inherit_tiers(investigation: dict, study: dict, assay: dict) -> dict[str, tuple[Any, str]]:
    """
    Merge the three tier blocks into a flat inherited dict.
    Values from lower tiers (assay) override higher ones (investigation) on key collision.
    Returns {field_name: (value, INHERITED)}.
    """
    result: dict[str, tuple[Any, str]] = {}
    for tier_data in (investigation, study, assay):
        for key, val in tier_data.items():
            if val not in (None, "", [], {}):
                result[key] = (val, INHERITED)
    return result


# ── Grid row builder ──────────────────────────────────────────────────────────

def _build_row(
    raw_bytes: bytes,
    filename: str,
    fluorometer: str | None,
    inherited: dict,
    token_dict: dict,
    FJ_ms: float = 2.0,
    FI_ms: float = 30.0,
) -> dict:
    """
    Build a single reconciliation-grid row for one uploaded file.

    Each field in the returned dict has the shape:
        {field_name: {"value": <any>, "provenance": <flag_constant>}}

    Internal keys (stripped before sending to JS):
        _meta      — parse metadata (fluorometer, n_points, parse_error)
        _transient — downsampled {'time_ms': [...], 'fluorescence': [...]}
    """
    stem = os.path.splitext(secure_filename(filename))[0].lower()
    row: dict[str, Any] = {}

    # 1. Apply inherited tier values first (lowest priority)
    for field_name, (val, prov) in inherited.items():
        row[field_name] = {"value": val, "provenance": prov}

    # 2. Apply filename tokens (override inherited for per_curve fields only)
    for field_name, (val, prov) in _parse_filename(stem, token_dict).items():
        if FIELDS.get(field_name, FieldDef("", "", "")).tier == "per_curve":
            row[field_name] = {"value": val, "provenance": prov}

    # 3. Auto-detect instrument from file content if not supplied by study
    fluo = fluorometer or _detect_fluorometer(filename, raw_bytes)
    if fluo:
        row["instrument"] = {"value": fluo, "provenance": FROM_HEADER}

    # 4. Mandatory auto-populated per-curve fields
    curve_id = stem + "_" + uuid.uuid4().hex[:8]
    row["curve_id"] = {"value": curve_id, "provenance": COMPUTED}
    row["filename"] = {"value": filename,  "provenance": FROM_HEADER}

    # 5. Parse transient + compute JIP parameters
    transient_data: dict | None = None
    parse_error: str | None = None
    n_points: int | None = None

    if fluo:
        try:
            df, x_col, ms_factor = _parse_transient(raw_bytes, filename, fluo)
            n_points = len(df)
            jip = _compute_jip_params(df, x_col, ms_factor, FJ_ms, FI_ms)
            for k, v in jip.items():
                if not k.startswith("jip_error"):
                    row[k] = {"value": v, "provenance": COMPUTED}
                else:
                    parse_error = str(v)
            transient_data = _downsample_transient(df, x_col, ms_factor)
        except Exception as exc:
            parse_error = str(exc)
    else:
        parse_error = "instrument not detected — set it manually in the Study block"

    # 6. Completeness score (computed last so all fields are present)
    row["completeness_score"] = {"value": _completeness_score(row), "provenance": COMPUTED}

    # 7. Internal metadata (not a FIELDS entry; stripped before export to JS grid)
    row["_meta"] = {
        "filename":   filename,
        "fluorometer": fluo,
        "n_points":   n_points,
        "parse_error": parse_error,
        "curve_id":   curve_id,
    }
    if transient_data is not None:
        row["_transient"] = transient_data

    return row


# ── Temporary transient store ─────────────────────────────────────────────────

def _get_upload_folder() -> str:
    try:
        from . import UPLOAD_FOLDER  # type: ignore[attr-defined]
        return UPLOAD_FOLDER
    except ImportError:
        return os.path.join(os.path.dirname(__file__), "static", "uploads")


def _transient_store_path(bundle_id: str) -> str:
    return os.path.join(_get_upload_folder(), f"_ann_{bundle_id}.json")


def _write_transient_store(bundle_id: str, store: dict) -> None:
    if not store:
        return
    try:
        folder = _get_upload_folder()
        os.makedirs(folder, exist_ok=True)
        with open(_transient_store_path(bundle_id), "w", encoding="utf-8") as fh:
            json.dump(store, fh)
    except Exception:
        pass  # non-fatal; export will lack transient data


def _read_transient_store(bundle_id: str) -> dict:
    try:
        path = _transient_store_path(bundle_id)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
    except Exception:
        pass
    return {}


# ── Parquet builder ────────────────────────────────────────────────────────────

def _build_parquet(state: dict) -> bytes | None:
    """
    Build a long-format ML-ready Parquet file from the annotation state.
    One row per (curve_id, time_ms) point.  All metadata columns are repeated.
    Per-field provenance is embedded in Parquet file-level metadata as JSON.
    Falls back to None (with a warning) when pyarrow is not installed.
    """
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        return None

    records: list[dict] = []
    prov_map: dict[str, dict] = {}

    for row in state.get("rows", []):
        cid = row.get("curve_id", {}).get("value", "")
        transient = row.get("_transient")

        # Flatten metadata: value only (provenance goes to file metadata)
        meta_flat: dict[str, Any] = {}
        prov_flat: dict[str, str] = {}
        for field_name, cell in row.items():
            if field_name.startswith("_"):
                continue
            if isinstance(cell, dict) and "value" in cell:
                meta_flat[field_name] = cell["value"]
                prov_flat[field_name] = cell.get("provenance", "")

        prov_map[cid] = prov_flat

        if transient:
            for t, f in zip(transient["time_ms"], transient["fluorescence"]):
                records.append({"curve_id": cid, "time_ms": t, "fluorescence": f,
                                 **meta_flat})
        else:
            records.append({"curve_id": cid, "time_ms": None, "fluorescence": None,
                             **meta_flat})

    if not records:
        return None

    df_out = pd.DataFrame(records)
    table  = pa.Table.from_pandas(df_out, preserve_index=False)
    table  = table.replace_schema_metadata({
        b"schema_version": SCHEMA_VERSION.encode(),
        b"tool":           b"cyano.tools/fluorescence_annotation",
        b"provenance":     json.dumps(prov_map).encode(),
    })

    buf = io.BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue()


# ── Bundle serialisation ──────────────────────────────────────────────────────

def bundle_serialise(state: dict) -> bytes:
    """
    Pack annotation state into a ZIP bundle:
        MANIFEST.json   — bundle identity and counts
        state.json      — tier blocks + token dict + per-curve rows with provenance
        dataset.parquet — ML-ready long-format dataset (omitted if pyarrow absent)
        dataset.csv     — CSV fallback when pyarrow is absent

    state schema:
        {
          'investigation': {field: value, ...},
          'study':         {field: value, ...},
          'assay':         {field: value, ...},
          'token_dict':    { ... },
          'rows': [
              {field_name: {'value': ..., 'provenance': ...}, '_meta': {...},
               '_transient': {'time_ms': [...], 'fluorescence': [...]}},
              ...
          ]
        }
    """
    bundle_id = uuid.uuid4().hex
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:

        # ── MANIFEST ──────────────────────────────────────────────────────────
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "bundle_id":      bundle_id,
            "created":        pd.Timestamp.now().isoformat(timespec="seconds"),
            "curve_count":    len(state.get("rows", [])),
            "tool":           "cyano.tools/fluorescence_annotation",
        }
        zf.writestr("MANIFEST.json", json.dumps(manifest, indent=2))

        # ── STATE (provenance-preserving; _transient stripped to save space) ──
        rows_clean = [
            {k: v for k, v in row.items() if k != "_transient"}
            for row in state.get("rows", [])
        ]
        state_out = {
            "schema_version": SCHEMA_VERSION,
            "investigation":  state.get("investigation", {}),
            "study":          state.get("study", {}),
            "assay":          state.get("assay", {}),
            "token_dict":     state.get("token_dict", {}),
            "rows":           rows_clean,
        }
        zf.writestr("state.json",
                    json.dumps(state_out, indent=2, ensure_ascii=False))

        # ── PARQUET (or CSV fallback) ─────────────────────────────────────────
        parquet_bytes = _build_parquet(state)
        if parquet_bytes:
            zf.writestr("dataset.parquet", parquet_bytes)
            manifest["parquet_included"] = True
        else:
            # CSV fallback: metadata only (no time-series)
            rows_meta = []
            for row in state.get("rows", []):
                flat = {k: v.get("value") for k, v in row.items()
                        if isinstance(v, dict) and "value" in v}
                rows_meta.append(flat)
            if rows_meta:
                csv_buf = io.StringIO()
                pd.DataFrame(rows_meta).to_csv(csv_buf, index=False)
                zf.writestr("dataset.csv", csv_buf.getvalue())
                manifest["csv_fallback"] = True

    return buf.getvalue()


def bundle_deserialise(data: bytes) -> dict:
    """
    Unpack a ZIP bundle and return the state dict.
    Raises ValueError on missing state.json or version mismatch.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        if "state.json" not in names:
            raise ValueError("Not a valid annotation bundle: state.json is missing")
        state = json.loads(zf.read("state.json").decode("utf-8"))
        if "MANIFEST.json" in names:
            state["_manifest"] = json.loads(zf.read("MANIFEST.json").decode("utf-8"))
        else:
            state["_manifest"] = {}

    bundle_ver = state.get("schema_version", "0.0.0")
    if bundle_ver != SCHEMA_VERSION:
        # Forward-compatibility: warn but continue
        state["_version_warning"] = (
            f"Bundle schema version {bundle_ver} differs from "
            f"current tool version {SCHEMA_VERSION}."
        )
    return state


# ── OJIP → annotation field name mapping ─────────────────────────────────────
# Keys: names used in js_OJIP.js paramData / key_values objects.
# Values: annotation FIELDS keys (jip_* prefix).

_OJIP_TO_ANN: dict[str, str] = {
    "F0":      "jip_F0",
    "FM":      "jip_FM",
    "FK":      "jip_FK",
    "FJ":      "jip_FJ",
    "FI":      "jip_FI",
    "FVFM":    "jip_Fv_Fm",
    "VJ":      "jip_VJ",
    "VI":      "jip_VI",
    "M0":      "jip_M0",
    "PSIE0":   "jip_psiE0",
    "PSIR0":   "jip_psiR0",
    "DELTAR0": "jip_deltaR0",
    "PHIE0":   "jip_phiE0",
    "PHIR0":   "jip_phiR0",
    "ABSRC":   "jip_ABS_RC",
    "TR0RC":   "jip_TR0_RC",
    "ET0RC":   "jip_ET0_RC",
    "RE0RC":   "jip_RE0_RC",
    "DI0RC":   "jip_DI0_RC",
    "Area_OJ": "jip_Area_OJ",
    "Area_JI": "jip_Area_JI",
    "Area_IP": "jip_Area_IP",
    "Area_OP": "jip_Area_OP",
    "SM":      "jip_Sm",
    "N":       "jip_N",
}


def _build_row_from_ojip_params(
    fname: str,
    fluorometer: str | None,
    kv: dict,       # key_values[fname] from ojipData
    params: dict,   # paramData[fname] from JS
    inherited: dict,
    token_dict: dict,
) -> dict:
    """
    Build an annotation grid row from already-computed OJIP parameters.
    Unlike _build_row, this requires no raw file bytes — all JIP values
    are taken directly from the OJIP analysis result already in JS memory.
    """
    row: dict = {}

    # Apply inherited tier metadata (investigation + study + assay)
    for k, (v, p) in inherited.items():
        if v not in (None, "", []):
            row[k] = {"value": v, "provenance": p}

    # Apply filename tokens for per_curve fields
    fname_tokens = _parse_filename(os.path.splitext(fname)[0], token_dict)
    for k, (v, p) in fname_tokens.items():
        if k in FIELDS and FIELDS[k].tier == "per_curve" and v not in (None, ""):
            row[k] = {"value": v, "provenance": p}

    # Core identifiers
    row["filename"] = {"value": fname, "provenance": FROM_HEADER}
    row["curve_id"] = {"value": os.path.splitext(fname)[0], "provenance": COMPUTED}

    # Instrument — from OJIP auto-detection (takes priority over inherited)
    if fluorometer:
        row["instrument"] = {"value": fluorometer, "provenance": FROM_HEADER}

    # Map OJIP parameter names → annotation jip_* fields
    # paramData (JS-computed, reflects user-edited FJ/FI times) takes precedence
    # over key_values (raw server output).
    for ojip_key, ann_key in _OJIP_TO_ANN.items():
        val = params.get(ojip_key)
        if val is None:
            val = kv.get(ojip_key)
        if val is None:
            continue
        try:
            fval = float(val)
            if not np.isnan(fval):
                row[ann_key] = {"value": round(fval, 6), "provenance": COMPUTED}
        except (TypeError, ValueError):
            pass

    # Completeness score
    row["completeness_score"] = {
        "value":      _completeness_score(row),
        "provenance": COMPUTED,
    }

    row["_meta"] = {"fluorometer": fluorometer, "source": "ojip_analysis"}
    return row


# ── Flask Blueprint + routes ──────────────────────────────────────────────────

fluorescence_annotation = Blueprint("fluorescence_annotation", __name__)


@fluorescence_annotation.route("/fluorescence_annotation", methods=["GET"])
def annotation_page():
    return render_template("fluorescence_annotation.html")


@fluorescence_annotation.route("/api/fluorescence_annotation/schema", methods=["GET"])
def schema_route():
    """Return the field schema as JSON (used by JS to build dropdowns)."""
    return jsonify(get_schema_json())


@fluorescence_annotation.route("/api/fluorescence_annotation/ingest_from_ojip", methods=["POST"])
def ingest_from_ojip():
    """
    Build annotation rows from already-computed OJIP results.
    Accepts a JSON body instead of raw file uploads, so no re-parsing is needed.

    JSON body:
        ojip_results  — { files, fluorometer, fj_time_ms, fi_time_ms,
                          key_values, param_data, time_raw_ms?, curves? }
        tier_json     — { investigation, study, assay, token_dict }
    """
    payload = request.get_json(force=True, silent=True) or {}
    ojip    = payload.get("ojip_results", {})
    tier    = payload.get("tier_json",    {})

    files       = ojip.get("files", [])
    fluorometer = ojip.get("fluorometer") or None
    key_values  = ojip.get("key_values",  {})
    param_data  = ojip.get("param_data",  {})
    time_raw_ms = ojip.get("time_raw_ms", [])
    curves      = ojip.get("curves",      {})

    if not files:
        return jsonify({"status": "error",
                        "message": "No files in ojip_results."}), 400

    investigation = tier.get("investigation", {})
    study         = tier.get("study",         {})
    assay         = tier.get("assay",         {})
    token_dict    = tier.get("token_dict",    {})

    # If instrument wasn't typed in the study form, fill it from OJIP detection.
    if fluorometer and not study.get("instrument"):
        study = dict(study)
        study["instrument"] = fluorometer

    inherited = _inherit_tiers(investigation, study, assay)

    rows:            list[dict]        = []
    warnings:        list[str]         = []
    bundle_id:       str               = str(uuid.uuid4())
    transient_store: dict[str, dict]   = {}

    for fname in files:
        kv     = key_values.get(fname, {})
        params = param_data.get(fname,  {})

        row = _build_row_from_ojip_params(
            fname, fluorometer, kv, params, inherited, token_dict
        )

        # Store raw transient if curves were passed (needed for Parquet export)
        curve_data = curves.get(fname, {})
        raw_fluor  = curve_data.get("raw", [])
        if time_raw_ms and raw_fluor and len(raw_fluor) == len(time_raw_ms):
            cid = row["curve_id"]["value"]
            transient_store[cid] = {
                "time_ms":     list(time_raw_ms),
                "fluorescence": list(raw_fluor),
            }

        issues = validate_row(row)
        row["_warnings"] = issues
        if issues:
            warnings.extend(issues)

        rows.append(row)

    if transient_store:
        _write_transient_store(bundle_id, transient_store)

    return jsonify({
        "status":         "ok",
        "bundle_id":      bundle_id,
        "rows":           rows,
        "tier_defaults":  {
            "investigation": investigation,
            "study":         study,
            "assay":         assay,
            "token_dict":    token_dict,
        },
        "warnings":        warnings,
        "schema_version":  SCHEMA_VERSION,
    })


@fluorescence_annotation.route("/api/fluorescence_annotation/ingest", methods=["POST"])
def ingest():
    """
    Receive raw fluorescence files + tier JSON.
    Returns pre-filled reconciliation grid rows.

    Form fields:
        fluo_files   — one or more raw fluorescence files
        tier_json    — JSON string: {investigation, study, assay, token_dict,
                                     FJ_time_ms (opt), FI_time_ms (opt)}
    """
    if "fluo_files" not in request.files:
        return jsonify({"status": "error", "message": "No files received."}), 400

    files = request.files.getlist("fluo_files")
    if not files or secure_filename(files[0].filename or "") == "":
        return jsonify({"status": "error", "message": "Please select one or more files."}), 400

    if len(files) > 200:
        return jsonify({"status": "error",
                        "message": "Maximum 200 files per batch."}), 400

    try:
        tier_json = json.loads(request.form.get("tier_json", "{}"))
    except json.JSONDecodeError:
        return jsonify({"status": "error", "message": "Invalid tier_json."}), 400

    investigation = tier_json.get("investigation", {})
    study         = tier_json.get("study", {})
    assay         = tier_json.get("assay", {})
    token_dict    = tier_json.get("token_dict", {})
    FJ_ms = float(tier_json.get("FJ_time_ms", 2.0))
    FI_ms = float(tier_json.get("FI_time_ms", 30.0))

    # Instrument from study block (user may have already chosen it)
    study_fluo = study.get("instrument") or None
    inherited  = _inherit_tiers(investigation, study, assay)

    rows: list[dict] = []
    warnings: list[str] = []
    transient_store: dict[str, dict] = {}

    for file in files:
        fname = file.filename or "unknown"
        raw   = file.read()
        fluo  = study_fluo or _detect_fluorometer(fname, raw)

        try:
            row = _build_row(raw, fname, fluo, inherited, token_dict, FJ_ms, FI_ms)
        except Exception as exc:
            row = {
                "filename":         {"value": fname,              "provenance": FROM_HEADER},
                "curve_id":         {"value": fname + "_err",     "provenance": COMPUTED},
                "completeness_score": {"value": 0.0,              "provenance": COMPUTED},
                "_meta": {"filename": fname, "fluorometer": fluo,
                          "n_points": None,  "parse_error": str(exc)},
            }
            warnings.append(f"{fname}: {exc}")

        # Stash transient; strip from row before JSON serialisation
        trans = row.pop("_transient", None)
        if trans:
            cid = row.get("curve_id", {}).get("value", "")
            transient_store[cid] = trans

        rows.append(row)

    bundle_id = uuid.uuid4().hex
    _write_transient_store(bundle_id, transient_store)

    return jsonify({
        "status":        "success",
        "bundle_id":     bundle_id,
        "rows":          rows,
        "tier_defaults": {
            "investigation": investigation,
            "study":         study,
            "assay":         assay,
            "token_dict":    token_dict,
            "FJ_time_ms":    FJ_ms,
            "FI_time_ms":    FI_ms,
        },
        "warnings":       warnings,
        "schema_version": SCHEMA_VERSION,
    })


@fluorescence_annotation.route("/api/fluorescence_annotation/export", methods=["POST"])
def export_bundle():
    """
    Receive the reviewed grid (JS posts back after user edits).
    Returns a base64-encoded ZIP bundle for download.

    JSON body: {bundle_id, rows, tier_defaults}
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"status": "error", "message": "No JSON body."}), 400

    bundle_id    = data.get("bundle_id", "")
    rows         = data.get("rows", [])
    tier_defaults = data.get("tier_defaults", {})

    # Re-attach transients from the temp store
    trans_store = _read_transient_store(bundle_id)
    for row in rows:
        cid = row.get("curve_id", {}).get("value", "")
        if cid in trans_store:
            row["_transient"] = trans_store[cid]

    state = {
        "investigation": tier_defaults.get("investigation", {}),
        "study":         tier_defaults.get("study", {}),
        "assay":         tier_defaults.get("assay", {}),
        "token_dict":    tier_defaults.get("token_dict", {}),
        "rows":          rows,
    }

    bundle_bytes = bundle_serialise(state)
    b64 = base64.b64encode(bundle_bytes).decode("ascii")

    project = tier_defaults.get("investigation", {}).get("project_title", "annotation")
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", project)[:40]

    return jsonify({
        "status":   "success",
        "bundle_b64": b64,
        "filename": f"{safe_name}_annotation_bundle.zip",
    })


@fluorescence_annotation.route("/api/fluorescence_annotation/load_bundle", methods=["POST"])
def load_bundle():
    """
    Receive an annotation bundle ZIP, deserialise, and return the grid state
    so the user can pick up where they left off or merge new files.
    """
    if "bundle_file" not in request.files:
        return jsonify({"status": "error", "message": "No bundle file received."}), 400

    try:
        state = bundle_deserialise(request.files["bundle_file"].read())
    except Exception as exc:
        return jsonify({"status": "error",
                        "message": f"Could not read bundle: {exc}"}), 400

    return jsonify({
        "status":    "success",
        "rows":      state.get("rows", []),
        "tier_defaults": {
            "investigation": state.get("investigation", {}),
            "study":         state.get("study", {}),
            "assay":         state.get("assay", {}),
            "token_dict":    state.get("token_dict", {}),
        },
        "schema_version":  state.get("schema_version", ""),
        "_manifest":       state.get("_manifest", {}),
        "_version_warning": state.get("_version_warning"),
    })


# ── Smoke test ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    import zipfile as _zf
    from pathlib import Path

    _root = Path(__file__).parent
    _zip_path = _root / "static" / "files" / "OJIP_example_files.zip"

    if not _zip_path.exists():
        print(f"Sample ZIP not found at {_zip_path}")
        sys.exit(1)

    # Extract first file from the sample ZIP
    with _zf.ZipFile(_zip_path) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        if not names:
            print("No files inside the sample ZIP.")
            sys.exit(1)
        _fname = names[0]
        _raw   = z.read(_fname)

    print(f"Sample file: {_fname}  ({len(_raw):,} bytes)")

    # Minimal tier blocks
    _inv   = {"project_title": "Smoke test project", "institution": "CzechGlobe",
               "contact_name": "T. Zavrel"}
    _study = {"organism": "Synechocystis sp. PCC 6803",
               "taxonomic_group": "Cyanobacteria",
               "dark_adaptation_min": 30,
               "instrument": None}     # will be auto-detected
    _assay = {"measurement_type": "OJIP"}
    _tdict = {
        "separator": "_",
        "tokens": [
            {"position": 0, "field": "strain"},
            {"position": 1, "field": "treatment"},
            {"position": 2, "field": "timepoint_h",  "strip_suffix": "h"},
            {"position": 3, "field": "replicate_id", "strip_prefix": "rep"},
        ],
    }

    _inherited = _inherit_tiers(_inv, _study, _assay)
    print(f"Inherited fields ({len(_inherited)}): {list(_inherited.keys())}\n")

    _row = _build_row(_raw, _fname, None, _inherited, _tdict)

    print("--- Grid row ---------------------------------------------------")
    for _k in sorted(_row.keys()):
        if _k.startswith("_"):
            continue
        _cell = _row[_k]
        _v, _p = _cell.get("value"), _cell.get("provenance", "")
        if _v is not None:
            print(f"  {_k:<35} = {str(_v):<22}  [{_p}]")

    _meta = _row.get("_meta", {})
    print("\n--- Parse metadata ---------------------------------------------")
    for _k, _v in _meta.items():
        print(f"  {_k}: {_v}")

    _score = _row.get("completeness_score", {}).get("value", "?")
    print(f"\nCompleteness score: {_score}%")

    if "_transient" in _row:
        _t = _row["_transient"]
        print(f"Transient: {len(_t['time_ms'])} points  "
              f"t=[{_t['time_ms'][0]:.4f} .. {_t['time_ms'][-1]:.4f}] ms")

    # Validation
    _issues = validate_row(_row)
    print(f"Validation issues: {_issues or 'none'}")

    # Bundle round-trip
    print("\n--- Bundle round-trip ------------------------------------------")
    _state = {
        "investigation": _inv,
        "study":         _study,
        "assay":         _assay,
        "token_dict":    _tdict,
        "rows":          [_row],
    }
    _bundle_bytes = bundle_serialise(_state)
    print(f"Bundle size: {len(_bundle_bytes):,} bytes")

    with _zf.ZipFile(io.BytesIO(_bundle_bytes)) as _z:
        print(f"Bundle contents: {_z.namelist()}")

    _state2 = bundle_deserialise(_bundle_bytes)
    assert _state2["investigation"]["project_title"] == "Smoke test project", \
        "Round-trip FAILED: project_title mismatch"
    assert len(_state2["rows"]) == 1, \
        "Round-trip FAILED: row count mismatch"
    _cid_orig  = _row["curve_id"]["value"]
    _cid_rt    = _state2["rows"][0].get("curve_id", {}).get("value")
    assert _cid_orig == _cid_rt, f"Round-trip FAILED: curve_id {_cid_orig!r} ≠ {_cid_rt!r}"

    print("Round-trip: OK")
    print("\nSmoke test passed.")
