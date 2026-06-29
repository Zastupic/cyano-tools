"""
ojip_interpretation.py — Biological interpretation layer for OJIP / JIP-test analysis.

Three public functions:
  interpret_ojip(params, organism_class, reference, measurement) -> dict
  generate_narrative(findings, params, reference)               -> str | None
  summarise_findings(findings)                                  -> str

Design principles (see task spec for full rationale):
  1. Organism class gates interpretation — cyanobacterial thresholds differ from plants/algae.
  2. JIP-test parameters are comparative.  Absolute "health" is only declared with a reference.
  3. Every finding cites its driver parameter.
  4. Validity gates run first; bad acquisition caps confidence and states technical reasons.
  5. PQ-redox poise is a first-class, primary output — framed separately from stress.
  6. LLM narrative is optional; the template fallback always works.
  7. Raw transients never leave the machine — only named scalar values are passed to LLM.

References embedded in rule comments:
  - Tsimilli-Michael (2020) Photosynthetica 58:275–292
  - Tóth et al. (2007) Biochim Biophys Acta 1767:295–305
  - Tsimilli-Michael et al. (2009) Biochim Biophys Acta 1787:1009–1016
  - Schansker et al. (2005) Biochim Biophys Acta 1706:250–261
  - Campbell et al. (1998) Biochemistry 37:11757–11766
  - Akinyemi et al. (2023) Front Plant Sci 14:1174293
  - Zavřel et al. (2026) Photosynthesis Research 164:6
"""

from __future__ import annotations

import math
import os
import logging

logger = logging.getLogger(__name__)

# ─── internal helpers ─────────────────────────────────────────────────────────

def _sf(v) -> float | None:
    """Safe float conversion; returns None on None / NaN / non-numeric."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


def _get(params: dict, *keys) -> float | None:
    """Retrieve first non-None value for a list of candidate key names."""
    for k in keys:
        v = _sf(params.get(k))
        if v is not None:
            return v
    return None


# ─── Part 1 — validity / quality gates ──────────────────────────────────────

def _run_validity_gates(params: dict, measurement: dict) -> dict:
    """
    Run all acquisition-validity gates (Zavřel et al. 2026).

    Returns a validity sub-dict that is attached to the top-level result.
    Sets acquisition_valid=False and populates blocking_issues when a gate fails.
    """
    m = measurement

    validity: dict = {
        "acquisition_valid": True,
        "fp_equals_fm": "uncertain",
        "within_physiological_limits": True,
        "vj_or_vjprime": "VJ",
        "f0_is_true_f0": True,
        "notes": [],
        "blocking_issues": [],
    }

    # ── Gate 1: acclimation state → VJ vs VJ′ ───────────────────────────────
    acclimation = m.get("acclimation")
    validity["acclimation"] = acclimation  # stored for downstream caveats
    if acclimation in ("light", "partial_dark"):
        validity["vj_or_vjprime"] = "VJ'"
    elif acclimation in (None, "unknown", ""):
        validity["vj_or_vjprime"] = "VJ"
        validity["notes"].append(
            "Acclimation state unknown; defaulting to VJ (dark-acclimated formula). "
            "Supply measurement['acclimation'] for correct VJ / VJ′ selection."
        )
    else:  # 'dark'
        validity["vj_or_vjprime"] = "VJ"

    # ── Gate 2: DCMU ─────────────────────────────────────────────────────────
    dcmu = m.get("dcmu")
    if dcmu:
        validity["blocking_issues"].append(
            "DCMU present: QA remains reduced; FM reached at the J-step; "
            "PQ oxidation downstream is invisible. PQ-redox poise cannot be "
            "reported from OJIP alone when DCMU is active."
        )
        # acquisition not fully invalid — but PQ-redox is blocked
        # (other parameters also lose meaning; set invalid)
        validity["acquisition_valid"] = False

    # ── Gate 3: saturation-pulse intensity ───────────────────────────────────
    sp = _sf(m.get("sp_intensity_umol"))
    if sp is None:
        validity["notes"].append(
            "Saturation-pulse intensity unknown. VJ may be underestimated if SP "
            "was insufficient to drive a clear J-step (VJ rises with SP intensity)."
        )
    elif sp < 2000:
        validity["notes"].append(
            f"Low saturation-pulse intensity ({sp:.0f} µmol photons m⁻² s⁻¹). "
            "J-step may be poorly defined; VJ likely underestimated."
        )
        validity["blocking_issues"].append(
            f"SP intensity {sp:.0f} µmol m⁻² s⁻¹ is below the threshold for reliable "
            "J-step detection (~2 000 µmol m⁻² s⁻¹)."
        )
        validity["acquisition_valid"] = False

    # ── Gate 4: culture density ───────────────────────────────────────────────
    # Expected unit: mg Chl a / L (or OD if instrument-specific).
    # Zavřel et al. (2026): above ~3.8 mg Chl a/L, reabsorption & scattering
    # artifacts distort VJ. Threshold is set at 3.8 for Chl a; if OD is supplied
    # instead, values above ~5 are roughly equivalent.
    density = _sf(m.get("culture_density"))
    instrument = str(m.get("instrument", "")).lower()
    if density is None:
        validity["notes"].append(
            "Culture density unknown (expected: mg Chl a / L); fluorescence "
            "reabsorption / inner-filter effects cannot be assessed."
        )
    elif density > 3.8:
        validity["notes"].append(
            f"High culture density ({density:.2f} mg Chl a / L). Above ~3.8 mg Chl a / L, "
            "fluorescence reabsorption and inner-filter effects may depress signal and "
            "shift VJ (Zavřel et al. 2026)."
        )
        validity["blocking_issues"].append(
            f"Culture density {density:.2f} exceeds 3.8 mg Chl a / L; inner-filter "
            "effect suspected."
        )
        validity["acquisition_valid"] = False
    elif "aquapen" in instrument and density > 2.0:
        validity["notes"].append(
            f"AquaPen at density {density:.2f}: detector saturation likely; "
            "VJ / Fv/Fm comparisons are semi-quantitative at best."
        )
        validity["blocking_issues"].append(
            "AquaPen detector saturation risk at this culture density."
        )
        validity["acquisition_valid"] = False

    # ── Gate 5: measuring light (PAM) ────────────────────────────────────────
    uses_ml = m.get("uses_measuring_light")
    if uses_ml and "pam" in instrument:
        validity["notes"].append(
            "Modulated measuring light is active on a PAM-type instrument. "
            "Centres may not be fully open at the start of the saturation pulse; "
            "F0 / VJ may be elevated."
        )
        validity["blocking_issues"].append(
            "Measuring light active on PAM: PSII centres may be partially closed at onset."
        )
        validity["acquisition_valid"] = False

    # ── Gate 6: FJ timing ────────────────────────────────────────────────────
    fj_timing = _sf(m.get("fj_timing_ms")) or _sf(params.get("FJ_time_user_ms"))
    if fj_timing is not None and acclimation in (None, "unknown", "dark", ""):
        if fj_timing < 0.5 or fj_timing > 5.0:
            validity["notes"].append(
                f"FJ picked at {fj_timing:.2f} ms (expected ~2 ms for dark-acclimated). "
                "A misplaced FJ corrupts VJ."
            )
            validity["blocking_issues"].append(
                f"FJ timing {fj_timing:.2f} ms outside expected 0.5–5 ms window."
            )

    # ── Gate 7: FP ≈ FM check ────────────────────────────────────────────────
    fm = _get(params, "FM", "Fmax")
    fi = _get(params, "FI")
    f0 = _get(params, "F0", "Fin")
    fj = _get(params, "FJ")
    fk = _get(params, "FK")
    fvfm = _get(params, "FVFM")

    if fm is not None and fi is not None and f0 is not None and fm > f0:
        fv = fm - f0
        ip_frac = (fm - fi) / fv if fv > 0 else None
        if ip_frac is not None:
            if ip_frac < 0.05:
                validity["fp_equals_fm"] = "likely"
                validity["notes"].append(
                    "I-step amplitude is very small (I ≈ P). The IP phase is nearly absent; "
                    "yields involving φR0 / δR0 should be treated as apparent."
                )
            else:
                validity["fp_equals_fm"] = "unlikely"

    # ── Gate 8: within physiological limits (dominant K-step) ───────────────
    if f0 is not None and fk is not None and fj is not None and fm is not None:
        fv_g = fm - f0
        w_ok = (fk - f0) / (fj - f0) if fv_g > 0 and (fj - f0) > 0 else None
        if (w_ok is not None and w_ok > 0.50
                and fvfm is not None and fvfm < 0.35):
            validity["within_physiological_limits"] = False
            validity["notes"].append(
                "Dominant K-step with strongly suppressed FM suggests OEC inactivation "
                "beyond normal physiological range. Derived biophysical parameters lose "
                "quantitative meaning."
            )

    # ── Cyanobacterial F0 flag ────────────────────────────────────────────────
    # (set by organism gate below; placeholder here)
    return validity


# ─── shape-flag detection ─────────────────────────────────────────────────────

def _compute_shape_flags(params: dict, organism_class: str | None,
                          validity: dict, reference: dict | None) -> list[str]:
    flags: list[str] = []
    f0 = _get(params, "F0", "Fin")
    fm = _get(params, "FM", "Fmax")
    fk = _get(params, "FK")
    fj = _get(params, "FJ")
    fi = _get(params, "FI")
    vj = _get(params, "VJ")
    vi = _get(params, "VI")

    if f0 is None or fm is None or fj is None or fi is None:
        return flags

    fv = fm - f0
    if fv <= 0:
        return flags

    # K-step: W_OJ at FK > expected for healthy plants/algae
    if fk is not None and (fj - f0) > 0:
        w_ok = (fk - f0) / (fj - f0)
        if w_ok > 0.35:
            flags.append("K_step_present")

    # OJS-shape: VI very high → I ≈ P (common in cyano / reduced PQ pool)
    if vi is not None and vi > 0.85:
        flags.append("OJS_shape")

    # IP suppressed: IP amplitude < 10 % of FV
    ip_rel = (fm - fi) / fv if fv > 0 else None
    if ip_rel is not None and ip_rel < 0.10:
        flags.append("IP_suppressed")

    # J anomalously high — for non-cyanobacteria only
    if vj is not None and vj > 0.80 and organism_class not in ("cyanobacteria",):
        flags.append("J_anomalously_high")

    # K-band / L-band require reference
    if reference is not None:
        ref_f0 = _get(reference, "F0", "Fin")
        ref_fk = _get(reference, "FK")
        ref_fj = _get(reference, "FJ")
        if ref_f0 is not None and ref_fk is not None and ref_fj is not None and fk is not None:
            ref_fv = _get(reference, "FV") or (_get(reference, "FM", "Fmax") or 0) - ref_f0
            ref_denom = (ref_fj - ref_f0) if ref_fj - ref_f0 > 0 else None
            denom = (fj - f0) if (fj - f0) > 0 else None
            if denom and ref_denom:
                w_ok_s = (fk - f0) / denom
                w_ok_r = (ref_fk - ref_f0) / ref_denom
                delta = w_ok_s - w_ok_r
                if delta > 0.05:
                    flags.append("K_band_positive")
                elif delta < -0.05:
                    flags.append("K_band_negative")
        # L-band proxy: compare W at FK (early sub-OJ region)
        # A true L-band uses the ~100 µs normalised wave; FK is the nearest proxy
        # Flag if ΔW_OK crosses ±0.07 without a K-step
        # (already covered by K_band above)

    return flags


# ─── individual finding generators ───────────────────────────────────────────

def _pq_redox_poise(params, organism_class, measurement, validity, shape_flags, reference):
    """
    Primary finding for algae and cyanobacteria (Zavřel et al. 2026).
    VJ = (FJ−F0)/(FM−F0) for dark-acclimated; VJ′ for light/partial.
    Higher VJ → more reduced PQ pool under normal conditions; however VJ near 1
    is ambiguous — two opposite mechanisms (PQ over-reduced vs QA→QB inhibition
    with oxidised PQ) produce the same signature.  See detail tiers.
    """
    m = measurement
    dcmu = m.get("dcmu")
    if dcmu:
        return {
            "available": False,
            "note": (
                "DCMU present: reaction centres are closed; FM is reached at the J-step; "
                "PQ oxidation downstream of QA is invisible. "
                "PQ-redox poise cannot be reported from OJIP alone when DCMU is active."
            ),
        }

    vj = _get(params, "VJ")
    if vj is None:
        return {"available": False, "note": "VJ not available."}

    vj_label = validity.get("vj_or_vjprime", "VJ")
    blocking = validity.get("blocking_issues", [])
    acq_valid = validity.get("acquisition_valid", True)

    # Confidence
    if not acq_valid:
        confidence = "low"
    else:
        confidence = "moderate"

    # Poise classification (organism-specific)
    if organism_class == "cyanobacteria":
        # Respiratory NDH-1/SDH reduces PQ in the dark → partial reduction is baseline
        if vj >= 0.90:
            poise = "reduced"
            detail = (
                f"{vj_label} = {vj:.3f} — highly reduced dark PQ pool. "
                "Consistent with State II (σII depressed, σI elevated) and active respiratory "
                "electron input (NDH-1 / SDH). Terminal oxidases (Cyd, COX) in the thylakoid "
                "membrane compete to oxidise PQH₂ but cannot overcome the strong respiratory input "
                "in this strain. Typical for Synechococcus PCC 7942 (V′J ≈ 1.0). "
                "This is the expected dark baseline for many cyanobacteria, not photosynthetic damage."
            )
        elif vj >= 0.60:
            poise = "partially_reduced"
            detail = (
                f"{vj_label} = {vj:.3f} — moderately reduced PQ pool. "
                "Consistent with respiratory NDH-1/SDH feeding electrons into PQ in the dark, "
                "partially counterbalanced by terminal oxidases (Cyd, COX) oxidising PQH₂; "
                "normal cyanobacterial baseline. "
                "Compare: Synechocystis 6803 V′J ≈ 0.88; Anabaena V′J ≈ 0.6–0.67; "
                "Planktothrix V′J ≈ 0.6 (Tsimilli-Michael et al. 2009)."
            )
        elif vj >= 0.30:
            poise = "balanced"
            detail = (
                f"{vj_label} = {vj:.3f} — partially oxidised PQ pool. "
                "Consistent with State I, enhanced PSI-mediated PQ oxidation, or active "
                "terminal oxidases (Cyd, COX) exceeding respiratory input. "
                "May follow far-red or blue pre-illumination."
            )
        else:
            poise = "oxidised"
            detail = (
                f"{vj_label} = {vj:.3f} — unusually low for dark-acclimated cyanobacteria. "
                "Consider whether far-red pre-illumination, DCMU washout, or methyl-viologen "
                "treatment was applied."
            )
        state_note = (
            "For dark-acclimated cyanobacteria, a partially-to-fully reduced PQ pool is the "
            "expected baseline (respiratory NDH-1/SDH activity) — this is not photosynthetic "
            "stress or damage. Only shifts relative to a reference carry interpretive weight "
            "for photosynthetic diagnosis."
        )
    else:
        # Plants / green algae
        if vj < 0.25:
            poise = "oxidised"
            detail = (
                f"{vj_label} = {vj:.3f} — well-oxidised PQ pool; fast QA⁻→QB exchange."
            )
        elif vj < 0.50:
            poise = "balanced"
            detail = (
                f"{vj_label} = {vj:.3f} — balanced PQ pool redox state; "
                "typical for dark-acclimated photosynthetic eukaryotes."
            )
        elif vj < 0.70:
            poise = "slightly_reduced"
            detail = (
                f"{vj_label} = {vj:.3f} — somewhat elevated J-level; "
                "QA⁻→QB exchange is partially limited. Possible: prior illumination, "
                "partial anaerobiosis, or acceptor-side limitation."
            )
        elif vj < 0.90:
            poise = "reduced"
            if "J_anomalously_high" in shape_flags:
                detail = (
                    f"{vj_label} = {vj:.3f} — reduced PQ pool; strong J-step. "
                    "QA⁻→QB exchange significantly restricted. "
                    "Possible causes: over-reduction of acceptor side (anaerobiosis, prior illumination) "
                    "or high SP-induced QA⁻ accumulation."
                )
            else:
                detail = (
                    f"{vj_label} = {vj:.3f} — elevated PQ pool reduction; "
                    "QA→QB exchange restricted."
                )
        else:
            poise = "severely_reduced"
            detail = (
                f"{vj_label} = {vj:.3f} — critically high; the OJIP transient approaches an "
                f"OJ profile (ψE₀ = 1 − VJ ≈ {max(0.0, 1.0 - vj):.3f}), meaning virtually no "
                "electron transfer beyond QA and the J-I and I-P phases are absent or negligible. "
                "Two mechanistically opposite states produce this signature: "
                "(a) complete over-reduction of the PQ pool — electrons back up at QA because "
                "downstream acceptors are saturated (PQ remains reduced); or "
                "(b) inhibition of QA⁻→QB transfer itself — electrons are trapped at QA while "
                "the PQ pool stays oxidised because it cannot be reached. "
                "Possible causes: QB-binding inhibitors (DCMU, atrazine), severe heat stress "
                "(>40 °C), prolonged anoxia, or complete acceptor-side over-reduction. "
                "Distinguishing the two scenarios requires additional evidence (e.g. far-red "
                "pre-illumination, PQ redox assay, or inhibitor history)."
            )
        state_note = (
            "A transient VJ′ rise shortly after dark→light transition is expected physiology "
            "(FNR/CBB not yet active, PQH₂ reoxidation delayed) — not a stress indicator. "
            "Caveat: VJ does not reflect PQ-redox well in samples with distinct PSI "
            "acceptor-side limitation (Y(NA)); if the IP phase is also anomalous, VJ changes "
            "may partly reflect Y(NA) differences rather than PQ-redox shifts "
            "(Zavřel et al. 2026). "
            "Under high actinic light (>500 µmol photons m⁻² s⁻¹), VJ′ dynamic range "
            "narrows and becomes unreliable for PQ-redox estimation."
        )
        if organism_class == "green_alga":
            state_note += (
                " Green algae typically show greater PQ-redox fluctuation than cyanobacteria. "
                "PTOX (plastid terminal oxidase) is present but less effective than cyanobacterial "
                "terminal oxidases (Cyd, COX). Primary PQ-reoxidation regulation in green algae "
                "relies on the xanthophyll cycle, NPQ, and state transitions (Zavřel et al. 2026)."
            )

    # Comparative framing if reference present
    if reference is not None:
        ref_vj = _get(reference, "VJ")
        if ref_vj is not None:
            delta = vj - ref_vj
            sign = "+" if delta > 0 else ""
            direction = "more reduced" if delta > 0 else "more oxidised"
            detail += (
                f" Relative to reference: Δ{vj_label} = {sign}{delta:.3f} ({direction}). "
            )
            if abs(delta) < 0.05:
                detail += "Minimal change from reference; no significant redox shift."

    result: dict = {
        "available": True,
        "driver": vj_label,
        "value": round(float(vj), 4),
        "poise": poise,
        "detail": detail,
        "state_note": state_note,
        "photoactive_pool_note": (
            "VJ reflects only the photoactive fraction of the PQ pool "
            "(estimated 25–55% of total PQ, species-dependent). "
            "The non-photoactive fraction (45–75%) is invisible to fluorescence-based methods; "
            "far-red pre-illumination can help estimate the photoactive pool size but cannot "
            "fully oxidise the total pool (Zavřel et al. 2026)."
        ),
        "confidence": confidence,
    }
    if not acq_valid:
        result["validity_warning"] = (
            "Acquisition gates failed — VJ estimate may reflect technical artifacts "
            "(SP intensity, density, instrument limitations) rather than true PQ-redox poise. "
            "Issues: " + "; ".join(blocking)
        )
    return result


def _psii_max_quantum_yield(params, organism_class, validity):
    """
    φP0 = Fv/Fm — maximum quantum yield of PSII primary photochemistry.
    Cyanobacteria: labelled apparent, PBS-confounded; standard thresholds NOT applied.
    """
    fvfm = _get(params, "FVFM")
    if fvfm is None:
        return {"available": False}

    acq_valid = validity.get("acquisition_valid", True)

    if organism_class == "cyanobacteria":
        # Fv/Fm in cyano is an apparent value (Fin ≠ F0; PBS + PSI inflate signal)
        # Reported apparent values: ~0.2–0.5 (apparent, species- and state-dependent) vs ~0.45–0.76 (true PSII yield)
        return {
            "available": True,
            "driver": "Fv/Fm (apparent — Fin-based, PBS/PSI-confounded)",
            "value": round(float(fvfm), 4),
            "level": "not_applicable",
            "confidence": "low",
            "detail": (
                f"Apparent (FM − Fin)/FM = {fvfm:.3f}. "
                "In cyanobacteria, Fin (the 'F0' of the JIP-test) is inflated by "
                "phycobilisome (PBS) and PSI fluorescence, and the dark PQ pool is partly "
                "reduced (respiratory NDH-1/SDH), further elevating Fin. "
                "Additionally, dark-acclimated cyanobacteria reside in State II (σII reduced), "
                "depressing apparent FM. "
                "True PSII quantum yield requires State-I induction (far-red / weak-blue "
                "pre-illumination) plus subtraction of PSI + free-PBS fluorescence contributions. "
                "DO NOT apply the vascular-plant thresholds (>0.75 healthy, etc.) to this value. "
                "Only compare to a reference from the same strain and instrument settings."
            ),
            "caveats": [
                "Apparent Fv/Fm is confounded by PBS and PSI fluorescence in cyanobacteria.",
                "True PSII yield requires far-red/blue State-I pre-illumination and fluorescence correction.",
                "Only interpret comparatively; even then, changes can reflect state transitions (I↔II), not photodamage.",
            ],
        }
    else:
        # Plants / green algae — standard thresholds (Strasser et al. 2000)
        if fvfm >= 0.75:
            level = "ok"
            detail = (
                f"Fv/Fm = {fvfm:.3f} — within the healthy range for vascular plants and "
                "green algae (typically 0.75–0.83). "
                "Indicates well-preserved PSII photochemistry: D1 protein intact, OEC "
                "functional, and complete dark-adaptation achieved. "
                "No primary photoinhibition or donor-side impairment detected. "
                "Values approaching 0.83 are seen in fully dark-adapted, unstressed leaves."
            )
        elif fvfm >= 0.65:
            level = "mild"
            detail = (
                f"Fv/Fm = {fvfm:.3f} — mildly below the healthy baseline (0.75–0.83). "
                "Consistent with: mild photoinhibition (moderate excess light), mild heat "
                "stress (<35 °C), mild drought or osmotic stress, sub-optimal nitrogen "
                "availability, or incomplete dark-adaptation (10–15 min may be insufficient). "
                "Partial D1 protein damage or reversible PSII down-regulation likely. "
                "Recovery upon stress removal is typically possible within hours."
            )
        elif fvfm >= 0.50:
            level = "moderate"
            detail = (
                f"Fv/Fm = {fvfm:.3f} — moderate reduction in PSII maximum quantum yield. "
                "Consistent with: significant photoinhibition, heat stress (35–42 °C), "
                "severe drought or osmotic stress, heavy-metal toxicity, nitrogen starvation, "
                "or combined abiotic stresses. "
                "Indicates partial D1 protein degradation or sustained PSII inactivation; "
                "the repair cycle cannot fully compensate damage. "
                "Check the K-step (W_OJ) for evidence of OEC inactivation as an additional cause. "
                "Recovery upon stress removal possible but prolonged."
            )
        else:
            level = "severe"
            detail = (
                f"Fv/Fm = {fvfm:.3f} — severe reduction in PSII quantum yield. "
                "Consistent with: severe or chronic photoinhibition, heat stress (>42 °C) "
                "causing OEC disassembly (detachment of Mn-cluster), severe drought or "
                "desiccation, donor-side limitation (OEC inactivation — direct water-splitting "
                "failure), or strong heavy-metal toxicity. "
                "D1 protein degradation likely exceeds repair capacity. "
                "Check W_OJ (K-step): a K-step with Fv/Fm < 0.50 is strong evidence of "
                "OEC inactivation. "
                "Note: very low FM combined with K-step indicates parameters lose quantitative "
                "biophysical meaning (see validity section)."
            )

        if organism_class == "green_alga":
            detail += (
                " Note for green algae: FM′ decline during illumination may reflect "
                "xanthophyll-cycle NPQ activation rather than photodamage. "
                "Green algae can show slightly lower dark-adapted Fv/Fm than C3 crop plants "
                "depending on species and growth conditions."
            )

        confidence = "moderate" if acq_valid else "low"
        result = {
            "available": True,
            "driver": "Fv/Fm",
            "value": round(float(fvfm), 4),
            "level": level,
            "detail": detail,
            "confidence": confidence,
        }
        if not validity.get("within_physiological_limits", True):
            result["validity_warning"] = (
                "Sample appears outside physiological limits (dominant K-step, suppressed FM). "
                "Fv/Fm is compromised."
            )
        return result


def _electron_transport_qa(params, organism_class, validity, shape_flags):
    """
    ψE0 = 1 − VJ — probability of trapped-electron transfer beyond QA⁻.
    Note: VJ also drives pq_redox_poise; report both but do not double-count.
    """
    vj = _get(params, "VJ")
    psie0 = _get(params, "PSIE0")
    phie0 = _get(params, "PHIE0")
    if vj is None:
        return {"available": False}

    psie0_val = psie0 if psie0 is not None else (1.0 - vj)
    acq_valid = validity.get("acquisition_valid", True)
    confidence = "low" if not acq_valid else "moderate"

    if organism_class == "cyanobacteria":
        detail = (
            f"VJ = {vj:.3f}, ψE0 = {psie0_val:.3f}. "
            "In cyanobacteria, a high VJ primarily reflects the dark PQ-pool redox poise "
            "(respiratory NDH-1/SDH activity → PQ partially reduced) rather than an "
            "electron-transport bottleneck. "
            "Only a shift in VJ relative to a reference indicates a true QA→QB limitation. "
            "See 'PQ-redox poise' for the primary interpretation."
        )
        return {
            "available": True,
            "driver": "VJ, ψE0",
            "vj": round(float(vj), 4),
            "psiE0": round(float(psie0_val), 4),
            "detail": detail,
            "confidence": confidence,
            "note": "Primary PQ-redox poise reading for cyanobacteria — see that finding.",
        }
    else:
        # Plants / green algae
        if vj > 0.65:
            level = "restricted"
            interp = (
                f"VJ = {vj:.3f} (ψE₀ = {psie0_val:.3f}) — restricted QA⁻→QB electron "
                "transfer; only {:.0f}% of trapped electrons proceed beyond QA. ".format(psie0_val * 100) +
                "The J-step is strongly elevated. "
                "Possible causes: "
                "(a) Over-reduced PQ pool — prolonged anaerobiosis, prior illumination, "
                "high CO₂ with impaired Calvin cycle consuming NADPH too slowly; "
                "(b) QA⁻→QB transfer inhibited — DCMU or atrazine (QB-binding herbicides), "
                "heat-damaged QB-site of D1 protein, or structural PSII changes at high "
                "temperature. "
                "High VJ in combination with high ABS/RC suggests a double limitation "
                "(antenna/RC imbalance and blocked electron flow)."
            )
        elif vj > 0.45:
            level = "partial_restriction"
            interp = (
                f"VJ = {vj:.3f} (ψE₀ = {psie0_val:.3f}) — moderately elevated J-step; "
                "{:.0f}% of trapped electrons proceed beyond QA. ".format(psie0_val * 100) +
                "Some restriction in QA⁻→QB transfer is present. "
                "Possible causes: partial anaerobiosis, recently switched off illumination "
                "(PQ pool not fully re-oxidised), mild acceptor-side limitation, or "
                "sub-threshold herbicide exposure."
            )
        else:
            level = "efficient"
            interp = (
                f"VJ = {vj:.3f} (ψE₀ = {psie0_val:.3f}) — efficient QA⁻→QB "
                "electron transfer; {:.0f}% of trapped electrons proceed beyond QA. ".format(psie0_val * 100) +
                "PQ exchange is not the limiting step. "
                "Consistent with well-oxidised PQ pool and uninhibited QB-site."
            )

        result = {
            "available": True,
            "driver": "VJ, ψE₀",
            "level": level,
            "vj": round(float(vj), 4),
            "psiE0": round(float(psie0_val), 4),
            "detail": interp,
            "confidence": confidence,
        }
        if phie0 is not None:
            result["phiE0"] = round(float(phie0), 4)
        return result


def _initial_slope_m0(params, organism_class, validity):
    """
    M₀ = initial slope of the OJIP rise (O→J phase).
    Approximated as 4 × VK / 1 ms (or equivalent).
    High M₀ → rapid QA⁻ accumulation; reflects excitation rate × kQA rate constant.
    """
    m0 = _get(params, "M0")
    if m0 is None:
        return {"available": False}

    acq_valid = validity.get("acquisition_valid", True)
    confidence = "low" if not acq_valid else "moderate"

    # Thresholds are calibrated for plants/green algae; cyanobacteria have
    # systematically different M₀ due to State II (reduced σII) and PBS/PSI F₀ inflation.
    is_cyano = organism_class == "cyanobacteria"
    thresh_high = 1.5 if is_cyano else 1.2
    thresh_low  = 0.15 if is_cyano else 0.3

    if m0 > thresh_high:
        level = "high"
        detail = (
            f"M₀ = {m0:.3f} — elevated initial slope of the O→J rise. "
            "Indicates rapid QA⁻ accumulation at the onset of the saturation pulse. "
            "Possible causes: "
            "(a) Large ABS/RC — a large effective antenna per active RC delivers photons "
            "quickly, closing RCs faster; "
            "(b) Pre-existing QA⁻ — incomplete dark-adaptation or prior illumination "
            "means some RCs start partially closed; "
            "(c) Restricted downstream electron flow — QA⁻ backs up rapidly when QA⁻→QB "
            "transfer is limited (high VJ). "
            "High M₀ combined with high VJ is consistent with acceptor-side bottleneck."
        )
    elif m0 < thresh_low:
        level = "low"
        detail = (
            f"M₀ = {m0:.3f} — low initial slope of the O→J rise. "
            "Indicates slow QA⁻ accumulation at the onset of the saturation pulse. "
            "Possible causes: "
            "(a) Small ABS/RC — reduced effective antenna per active RC, limiting excitation "
            "rate (antenna disconnection, state transition to State I); "
            "(b) Photoinhibitory damage — inactivation of RCs reduces the fraction of "
            "centres that accumulate QA⁻, lowering the apparent initial slope; "
            "(c) Low PSII excitation cross-section — e.g. after state transition in algae "
            "or PBS decoupling in cyanobacteria. "
            "Low M₀ together with low Fv/Fm is consistent with photoinhibitory PSII damage."
        )
    else:
        level = "normal"
        detail = (
            f"M₀ = {m0:.3f} — normal initial slope of the O→J rise. "
            "Consistent with a functional PSII excitation rate and unimpaired QA "
            "reduction kinetics."
        )

    if is_cyano:
        confidence = "low"
        detail += (
            " In cyanobacteria, M₀ is affected by State II dominance in the dark "
            "(reduced σII lowers apparent initial slope), by PBS fluorescence "
            "contribution to Fin, and potentially by OCP-NPQ if the sample was "
            "previously exposed to high light. "
            "Thresholds are shifted to account for these effects; interpret with caution."
        )

    return {
        "available": True,
        "driver": "M₀ (initial slope O→J rise)",
        "value": round(float(m0), 4),
        "level": level,
        "detail": detail,
        "confidence": confidence,
    }


def _pq_pool_reduction(params, organism_class, validity):
    """
    JI phase — net reduction of the PQ pool (pool size dominated by PQ).
    Parameters: VI, Area J–I, Sm, N.
    """
    vi = _get(params, "VI")
    if vi is None:
        return {"available": False}

    psir0 = _get(params, "PSIR0")
    area_ji = _get(params, "Area_JI")
    sm = _get(params, "SM")
    n = _get(params, "N")
    acq_valid = validity.get("acquisition_valid", True)
    confidence = "low" if not acq_valid else "moderate"

    psir0_val = psir0 if psir0 is not None else (1.0 - vi)

    # VI tier
    if vi > 0.90:
        vi_interp = (
            f"VI = {vi:.3f} (ψR₀ = {psir0_val:.3f}) — very high I-step; "
            "the PQ pool approaches full reduction during the transient. "
            "Intersystem electron carriers are essentially saturated; "
            "electron flow to PSI end-acceptors may be limiting."
        )
    elif vi > 0.70:
        vi_interp = (
            f"VI = {vi:.3f} (ψR₀ = {psir0_val:.3f}) — elevated I-step; "
            "substantial PQ-pool reduction during the transient. "
            "PSI electron demand is not keeping pace with PSII supply."
        )
    elif vi > 0.45:
        vi_interp = (
            f"VI = {vi:.3f} (ψR₀ = {psir0_val:.3f}) — moderate J–I amplitude; "
            "consistent with balanced PSII electron supply and PSI demand."
        )
    else:
        vi_interp = (
            f"VI = {vi:.3f} (ψR₀ = {psir0_val:.3f}) — low I-step; "
            "either a small PQ pool or very rapid PSI-side reoxidation. "
            "Possible causes: high PSI activity, far-red pre-illumination leaving "
            "PQ already partially oxidised, or genuinely small PQ pool."
        )

    detail = (
        vi_interp + " "
        "The J–I phase reflects net PQ-pool reduction driven by PSII electron input; "
        "its amplitude depends on PQ-pool size, QB-site exchange rate, and "
        "the balance between PSII supply and Cyt b₆/f + PSI demand. "
    )
    if area_ji is not None:
        detail += f"Complementary area J–I = {area_ji:.4f}. "
    if sm is not None:
        if sm > 30:
            detail += (
                f"Sm = {sm:.2f} — large normalised area; large total electron-carrier "
                "pool capacity. Consistent with high buffering against fluctuating light "
                "and resilient electron transport chain."
            )
        elif sm > 15:
            detail += (
                f"Sm = {sm:.2f} — normal normalised area; "
                "typical electron-carrier pool for healthy dark-adapted samples."
            )
        elif sm > 5:
            detail += (
                f"Sm = {sm:.2f} — below-average normalised area; "
                "limited electron-carrier pool. "
                "Possible causes: reduced PQ pool size, PSII damage reducing the "
                "functional pool accessible per RC, or acceptor-side limitation."
            )
        else:
            detail += (
                f"Sm = {sm:.2f} — very small normalised area; "
                "severely limited electron-carrier pool capacity. "
                "Consistent with strong photoinhibitory damage, very small PQ pool, "
                "or near-complete acceptor-side block."
            )
    if n is not None:
        if n > 60:
            detail += (
                f" N = {n:.1f} — high QA turnover number; "
                "each active RC reduces QA many times before FM is reached, "
                "reflecting a large PQ pool relative to PSII."
            )
        elif n > 20:
            detail += (
                f" N = {n:.1f} — normal QA turnover number."
            )
        else:
            detail += (
                f" N = {n:.1f} — low QA turnover number; "
                "few QA reduction cycles before the pool is full. "
                "May indicate a small PQ pool or high initial PSII closure."
            )

    return {
        "available": True,
        "driver": "VI, Area J–I, Sm, N",
        "vi": round(float(vi), 4),
        "psir0": round(float(psir0_val), 4),
        "sm": round(float(sm), 4) if sm is not None else None,
        "n": round(float(n), 2) if n is not None else None,
        "detail": detail,
        "confidence": confidence,
    }


def _psi_acceptor_side(params, organism_class, validity, shape_flags):
    """
    I-P phase — reduction of PC⁺, P700⁺ and PSI end-electron acceptors.
    Parameters: δR0, φR0, VI.
    """
    vi = _get(params, "VI")
    vj = _get(params, "VJ")
    phir0 = _get(params, "PHIR0")
    deltar0 = _get(params, "DELTAR0")
    fm = _get(params, "FM", "Fmax")
    fi = _get(params, "FI")
    f0 = _get(params, "F0", "Fin")

    if vi is None or vj is None:
        return {"available": False}

    acq_valid = validity.get("acquisition_valid", True)
    ip_suppressed = "IP_suppressed" in shape_flags
    confidence = "low" if not acq_valid else "moderate"
    if not validity.get("within_physiological_limits", True):
        confidence = "low"

    dr0_str = f"{deltar0:.3f}" if deltar0 is not None else "N/A"
    pr0_str = f"{phir0:.3f}" if phir0 is not None else "N/A"

    if ip_suppressed:
        level = "suppressed"
        detail = (
            f"IP phase strongly suppressed (FI ≈ FM); δR₀ = {dr0_str}; φR₀ = {pr0_str}. "
            "Electron flow to PSI end-acceptors (ferredoxin/thioredoxin/NADPH) is severely "
            "inhibited — virtually no electrons proceed beyond PC/P700 to the stromal "
            "acceptors during the induction transient. "
            "Possible causes: "
            "(a) FNR dark inactivation — common in freshly dark-adapted samples (15–30 min "
            "dark); the ferredoxin:NADP⁺ oxidoreductase is inactive until stromal NADP⁺ is "
            "available after illumination; "
            "(b) Methyl viologen treatment — MV acts as an artificial electron acceptor "
            "competing with ferredoxin, rerouting electrons before the IP phase builds; "
            "(c) PSI acceptor-side limitation (Y(NA)) — stromal over-reduction (prolonged "
            "illumination, CBB inhibition by glycolaldehyde) blocks electron flow beyond PSI; "
            "(d) Disconnection of PSI from the electron transport chain. "
            "Note: mild IP suppression in freshly dark-adapted samples is expected physiology."
        )
    else:
        fv = (fm - f0) if (fm is not None and f0 is not None) else None
        ip_frac = ((fm - fi) / fv) if (fm is not None and fv is not None and fv > 0 and fi is not None) else None
        if ip_frac is not None and ip_frac < 0.15:
            level = "reduced"
            detail = (
                f"Reduced I–P amplitude ({ip_frac:.2f} × FV); δR₀ = {dr0_str}; φR₀ = {pr0_str}. "
                "Electron flow to PSI terminal acceptors (ferredoxin / NADPH) is partially "
                "limited. "
                "Possible causes: partial FNR inactivation, sub-saturating PSI acceptor pool, "
                "mild Y(NA) limitation, or altered stromal redox balance. "
            )
        else:
            level = "normal"
            detail = (
                f"I–P phase present; δR₀ = {dr0_str}; φR₀ = {pr0_str}. "
                "PSI acceptor side is functional: electrons reach the stromal acceptors "
                "(ferredoxin/NADPH) during the induction transient. "
            )

        # δR₀ interpretation — guard against divergence when VJ near 1
        if deltar0 is not None:
            vj_near_1 = vj is not None and vj >= 0.85
            if vj_near_1:
                detail += (
                    f"δR₀ = {deltar0:.3f} — CAUTION: VJ = {vj:.3f} is close to 1, so "
                    "ψE₀ ≈ {:.3f} is near zero. ".format(max(0.0, 1.0 - vj)) +
                    "δR₀ = ψR₀/ψE₀ diverges as ψE₀ → 0; this value is a mathematical "
                    "artefact, not a reliable biological measure."
                )
                confidence = "low"
            elif deltar0 > 0.7:
                detail += (
                    f"δR₀ = {deltar0:.3f} — high probability of electron transfer to "
                    "PSI end-acceptors per electron arriving at intersystem carriers. "
                    "Indicates efficient PSI end-acceptor reduction; "
                    "Fd/NADPH pathway is not limiting."
                )
            elif deltar0 > 0.4:
                detail += (
                    f"δR₀ = {deltar0:.3f} — moderate probability of electron transfer "
                    "to PSI end-acceptors. "
                    "Partially functional PSI acceptor pathway."
                )
            else:
                detail += (
                    f"δR₀ = {deltar0:.3f} — low probability of electron transfer to "
                    "PSI end-acceptors. "
                    "PSI acceptor-side limitation: possible FNR inactivation, stromal "
                    "over-reduction, methyl-viologen competition, or altered Y(NA) state."
                )

    result: dict = {
        "available": True,
        "driver": "VI, δR0, φR0, IP-phase amplitude",
        "level": level,
        "ip_suppressed": ip_suppressed,
        "detail": detail,
        "confidence": confidence,
    }
    if deltar0 is not None:
        result["deltaR0"] = round(float(deltar0), 4)
    if phir0 is not None:
        result["phiR0"] = round(float(phir0), 4)
    return result


def _donor_side_oec(params, organism_class, validity, shape_flags, reference):
    """
    K-step / K-band — donor side / OEC integrity.
    W_OJ = (FK−F0)/(FJ−F0); K-step present → OEC inactivation likely.
    """
    f0 = _get(params, "F0", "Fin")
    fk = _get(params, "FK")
    fj = _get(params, "FJ")
    fm = _get(params, "FM", "Fmax")
    fvfm = _get(params, "FVFM")

    if f0 is None or fk is None or fj is None or fm is None:
        return {"available": False}

    fv = fm - f0
    w_ok = (fk - f0) / (fj - f0) if (fv > 0 and (fj - f0) > 0) else None
    k_step = "K_step_present" in shape_flags
    k_band = "K_band_positive" in shape_flags
    acq_valid = validity.get("acquisition_valid", True)
    confidence = "low" if not acq_valid else "moderate"

    w_str = f"{w_ok:.3f}" if w_ok is not None else "N/A"

    if not k_step and not k_band:
        return {
            "available": True,
            "driver": "W_OJ = (FK−F0)/(FJ−F0)",
            "k_step_present": False,
            "w_ok": round(float(w_ok), 4) if w_ok is not None else None,
            "level": "ok",
            "detail": (
                f"W_OJ = {w_str} — no prominent K-step. OEC appears functional."
            ),
            "confidence": confidence,
        }

    detail = (
        f"W_OJ = {w_str} — K-step detected at ~300 µs. "
        "A shoulder or local maximum near FK is the hallmark of OEC inactivation: "
        "P680⁺ is re-reduced by alternative donors (Tyr-D, carotenoids) rather than water. "
        "Classic inducers: heat stress (≥38–40°C), severe drought. "
        "Distinguishing from large antenna: OEC inactivation lowers FM; "
        "a larger functional antenna does not. "
    )
    if fvfm is not None:
        detail += f"Fv/Fm = {fvfm:.3f}; "
        if fvfm < 0.40:
            detail += "co-occurrence of K-step and low Fv/Fm supports OEC inactivation. "
    if not validity.get("within_physiological_limits", True):
        detail += (
            "Dominant K-step with strongly suppressed FM: biophysical parameters "
            "lose quantitative meaning beyond this point."
        )
        confidence = "low"
    if k_band and reference is not None:
        detail += " Positive K-band vs reference confirms donor-side impairment."

    return {
        "available": True,
        "driver": "W_OJ = (FK−F0)/(FJ−F0), K-step / K-band",
        "k_step_present": k_step,
        "k_band_positive": k_band,
        "w_ok": round(float(w_ok), 4) if w_ok is not None else None,
        "level": "impaired",
        "detail": detail,
        "confidence": confidence,
    }


def _antenna_and_rcs(params, organism_class, validity):
    """
    Specific fluxes per active RC: ABS/RC, TR0/RC, ET0/RC, RE0/RC, DI0/RC.
    ABS/RC = apparent absorption per active RC (antenna size proxy).
    """
    absrc  = _get(params, "ABSRC")
    tr0rc  = _get(params, "TR0RC")
    et0rc  = _get(params, "ET0RC")
    re0rc  = _get(params, "RE0RC")
    di0rc  = _get(params, "DI0RC")
    if absrc is None:
        return {"available": False}

    rc_abs = (1.0 / absrc) if absrc > 0 else None
    acq_valid = validity.get("acquisition_valid", True)
    confidence = "low" if (not acq_valid or organism_class == "cyanobacteria") else "moderate"

    # ── ABS/RC ───────────────────────────────────────────────────────────────
    if absrc > 4.0:
        absrc_interp = (
            f"ABS/RC = {absrc:.3f} — elevated; "
            "a large fraction of absorbed light is funnelled into each active RC, "
            "or silent (non-QA-reducing) RCs are present, effectively increasing the "
            "antenna load on remaining active RCs. "
            "Silent RCs arise from photoinhibitory inactivation of D1 or QB-site blockage. "
            "Distinguish: silent RCs → FM decreases; larger true antenna → FM stable or rises "
            "(Tsimilli-Michael 2020)."
        )
    elif absrc < 1.5:
        absrc_interp = (
            f"ABS/RC = {absrc:.3f} — below typical range; "
            "unusually small apparent antenna per active RC. "
            "May reflect: antenna uncoupling, very small light-harvesting complex, "
            "or measurement artefact."
        )
    else:
        absrc_interp = (
            f"ABS/RC = {absrc:.3f} — apparent absorbed photon flux per active "
            "(QA-reducing) RC. "
            "Represents the effective antenna size per functional RC."
        )

    detail = (
        absrc_interp
        + (f" RC/ABS = {rc_abs:.4f}." if rc_abs is not None else "")
        + " "
    )

    # ── TR₀/RC ───────────────────────────────────────────────────────────────
    if tr0rc is not None:
        if tr0rc > 4.0:
            detail += (
                f"TR₀/RC = {tr0rc:.3f} — high trapping flux per RC; "
                "each active RC is trapping a large number of excitons. "
            )
        elif tr0rc < 1.5:
            detail += (
                f"TR₀/RC = {tr0rc:.3f} — low trapping flux per RC. "
            )
        else:
            detail += f"TR₀/RC = {tr0rc:.3f} — trapping flux per active RC. "

    # ── ET₀/RC ───────────────────────────────────────────────────────────────
    if et0rc is not None:
        if et0rc > 2.5:
            detail += (
                f"ET₀/RC = {et0rc:.3f} — high electron transport flux to PQ per active RC; "
                "intersystem electron transport is proceeding efficiently. "
            )
        elif et0rc < 0.5:
            detail += (
                f"ET₀/RC = {et0rc:.3f} — low electron transport flux to PQ per active RC. "
                "Possible causes: strong acceptor-side limitation (high VJ), "
                "QB-site inhibition, or many silent RCs diluting the flux. "
            )
        else:
            detail += (
                f"ET₀/RC = {et0rc:.3f} — electron transport flux to PQ per active RC "
                "(proportional to ψE₀ = 1 − VJ). "
            )

    # ── RE₀/RC ───────────────────────────────────────────────────────────────
    if re0rc is not None:
        if re0rc > 1.0:
            detail += (
                f"RE₀/RC = {re0rc:.3f} — substantial electron flux reaching PSI "
                "end-acceptors (Fd/NADPH) per active RC; PSI is accepting electrons. "
            )
        elif re0rc < 0.2:
            detail += (
                f"RE₀/RC = {re0rc:.3f} — very low electron flux to PSI end-acceptors; "
                "PSI acceptor side is limited or the I–P phase is suppressed "
                "(see PSI acceptor-side finding). "
            )
        else:
            detail += (
                f"RE₀/RC = {re0rc:.3f} — electron flux reaching PSI end-acceptors "
                "per active RC. "
            )

    # ── DI₀/RC ───────────────────────────────────────────────────────────────
    if di0rc is not None:
        detail += (
            f"DI₀/RC = {di0rc:.3f} — energy dissipated (as heat/fluorescence) per active RC "
            "(= ABS/RC − TR₀/RC). "
        )
        if di0rc > 3.0:
            detail += (
                "Elevated dissipation per RC: a large fraction of absorbed light is not "
                "used for photochemistry. "
                "Causes: high proportion of silent/inactive RCs, high NPQ activity, or "
                "photoinhibitory energy dissipation. "
            )
        elif di0rc < 1.0:
            detail += (
                "Low dissipation per RC: most absorbed light is used productively. "
                "Consistent with efficient photochemistry and low NPQ."
            )

    if organism_class == "cyanobacteria":
        detail += (
            " Caution: for cyanobacteria, all specific fluxes (ABS/RC, TR₀/RC, ET₀/RC, "
            "RE₀/RC, DI₀/RC) are affected because Fin includes PBS and PSI contributions, "
            "inflating F₀-dependent calculations. "
            "Interpret comparatively (same strain, same instrument settings) only."
        )

    result = {
        "available": True,
        "driver": "ABS/RC, TR₀/RC, ET₀/RC, RE₀/RC, DI₀/RC",
        "ABS_RC": round(float(absrc), 4),
        "RC_ABS": round(float(rc_abs), 4) if rc_abs is not None else None,
        "TR0_RC": round(float(tr0rc), 4) if tr0rc is not None else None,
        "detail": detail,
        "confidence": confidence,
    }
    if et0rc is not None:
        result["ET0_RC"] = round(float(et0rc), 4)
    if re0rc is not None:
        result["RE0_RC"] = round(float(re0rc), 4)
    if di0rc is not None:
        result["DI0_RC"] = round(float(di0rc), 4)
    return result


def _energetic_connectivity(params, organism_class, validity, reference):
    """
    L-band — energetic connectivity / grouping probability pG.
    Meaningful only with a reference; computed from ΔW_OJ.
    """
    if reference is None:
        return {
            "available": False,
            "note": (
                "Energetic connectivity (L-band, grouping probability pG) requires a "
                "reference sample for ΔW calculation."
            ),
        }

    f0 = _get(params, "F0", "Fin")
    fk = _get(params, "FK")
    fj = _get(params, "FJ")
    ref_f0 = _get(reference, "F0", "Fin")
    ref_fk = _get(reference, "FK")
    ref_fj = _get(reference, "FJ")

    if (f0 is None or fk is None or fj is None
            or ref_f0 is None or ref_fk is None or ref_fj is None):
        return {"available": False, "note": "Insufficient data for L-band calculation."}

    denom_s = fj - f0
    denom_r = ref_fj - ref_f0
    if denom_s <= 0 or denom_r <= 0:
        return {"available": False, "note": "Cannot compute W_OJ (FJ − F0 ≤ 0)."}

    w_ok_s = (fk - f0) / denom_s
    w_ok_r = (ref_fk - ref_f0) / denom_r
    delta_w = w_ok_s - w_ok_r
    acq_valid = validity.get("acquisition_valid", True)
    confidence = "low" if not acq_valid else "moderate"

    if delta_w > 0.07:
        l_band = "positive"
        detail = (
            f"ΔW_OJ = +{delta_w:.3f} — positive L-band. "
            "Decreased connectivity (lower grouping probability pG) between PSII units "
            "compared to reference. Energy sharing between PSII centres is reduced "
            "(Tsimilli-Michael 2020)."
        )
    elif delta_w < -0.07:
        l_band = "negative"
        detail = (
            f"ΔW_OJ = {delta_w:.3f} — negative L-band. "
            "Increased PSII connectivity compared to reference."
        )
    else:
        l_band = "neutral"
        detail = (
            f"ΔW_OJ = {delta_w:+.3f} — no significant L-band; "
            "PSII connectivity similar to reference."
        )

    return {
        "available": True,
        "driver": "ΔW_OJ (L-band proxy)",
        "l_band": l_band,
        "delta_w_ok": round(float(delta_w), 4),
        "w_ok_sample": round(float(w_ok_s), 4),
        "w_ok_reference": round(float(w_ok_r), 4),
        "detail": detail,
        "confidence": confidence,
    }


def _overall_performance(params, organism_class, validity, reference):
    """
    PIabs — overall performance index spanning ABS → inter-system electron transport.
    Only reported as a ratio to reference (or as ΔDF = Δlog PI).
    """
    fvfm = _get(params, "FVFM")
    vj = _get(params, "VJ")
    absrc = _get(params, "ABSRC")

    pi_abs = None
    pi_val_str = "N/A"

    # Compute PIabs even if no reference (surface value + caveat)
    if fvfm is not None and vj is not None and absrc is not None:
        psie0 = 1.0 - vj
        rc_abs = (1.0 / absrc) if absrc > 0 else None
        denom_fvfm = 1.0 - fvfm
        denom_psi = 1.0 - psie0 if psie0 < 1.0 else None
        if (rc_abs is not None and denom_fvfm > 0
                and denom_psi is not None and denom_psi > 0
                and psie0 > 0 and fvfm > 0):
            pi_abs = rc_abs * (fvfm / denom_fvfm) * (psie0 / denom_psi)
            pi_val_str = f"{pi_abs:.4f}"

    acq_valid = validity.get("acquisition_valid", True)
    confidence = "low" if (not acq_valid or organism_class == "cyanobacteria") else "moderate"

    if reference is None:
        caveat = (
            "PIabs is not interpretable in absolute terms — it lives on an arbitrary scale. "
            "Supply a reference/control sample to report the ratio (PI/PI_ref) or "
            "ΔDF = log(PI/PI_ref)."
        )
        return {
            "available": True,
            "driver": "PIabs = RC/ABS × φP0/(1−φP0) × ψE0/(1−ψE0)",
            "pi_abs": round(float(pi_abs), 6) if pi_abs is not None else None,
            "ratio": None,
            "df_delta": None,
            "detail": (
                f"PIabs (sample) ≈ {pi_val_str}. {caveat}"
            ),
            "confidence": confidence,
        }

    # With reference
    ref_fvfm = _get(reference, "FVFM")
    ref_vj = _get(reference, "VJ")
    ref_absrc = _get(reference, "ABSRC")

    if ref_fvfm is None or ref_vj is None or ref_absrc is None:
        return {
            "available": True,
            "driver": "PIabs",
            "pi_abs": round(float(pi_abs), 6) if pi_abs is not None else None,
            "ratio": None,
            "df_delta": None,
            "detail": (
                f"PIabs (sample) ≈ {pi_val_str}. "
                "Reference PIabs could not be computed (missing reference parameters)."
            ),
            "confidence": confidence,
        }

    ref_psie0 = 1.0 - ref_vj
    ref_rc_abs = (1.0 / ref_absrc) if ref_absrc > 0 else None
    ref_denom_fvfm = 1.0 - ref_fvfm
    ref_denom_psi = 1.0 - ref_psie0 if ref_psie0 < 1.0 else None

    ref_pi_abs = None
    if (ref_rc_abs is not None and ref_denom_fvfm > 0
            and ref_denom_psi is not None and ref_denom_psi > 0
            and ref_psie0 > 0 and ref_fvfm > 0):
        ref_pi_abs = ref_rc_abs * (ref_fvfm / ref_denom_fvfm) * (ref_psie0 / ref_denom_psi)

    ratio = (pi_abs / ref_pi_abs) if (pi_abs and ref_pi_abs and ref_pi_abs > 0) else None
    df_delta = math.log(ratio) if (ratio and ratio > 0) else None

    ratio_str = f"{ratio:.3f}" if ratio is not None else "N/A"
    df_str = f"{df_delta:+.3f}" if df_delta is not None else "N/A"
    ref_str = f"{ref_pi_abs:.4f}" if ref_pi_abs is not None else "N/A"

    detail = (
        f"PIabs (sample) ≈ {pi_val_str}; PIabs (reference) ≈ {ref_str}; "
        f"ratio = {ratio_str}; ΔDF = {df_str}. "
        "PIabs integrates RC density, PSII yield, and electron-transport efficiency; "
        "it is the most sensitive single composite parameter (Tsimilli-Michael 2020). "
    )
    if ratio is not None:
        if ratio < 0.5:
            detail += "Large drop relative to reference (>50% reduction)."
        elif ratio < 0.8:
            detail += "Moderate reduction relative to reference."
        elif ratio > 1.2:
            detail += "Improved performance relative to reference."
        else:
            detail += "Similar to reference."

    if organism_class == "cyanobacteria":
        detail += (
            " For cyanobacteria, all three PIabs components are confounded: Fv/Fm is apparent "
            "(PBS/PSI-inflated F₀), ABS/RC depends on inflated F₀, and VJ reflects respiratory "
            "PQ reduction rather than only photosynthetic electron transport. "
            "Treat the ratio as semi-quantitative."
        )

    return {
        "available": True,
        "driver": "PIabs = RC/ABS × φP0/(1−φP0) × ψE0/(1−ψE0)",
        "pi_abs": round(float(pi_abs), 6) if pi_abs is not None else None,
        "ref_pi_abs": round(float(ref_pi_abs), 6) if ref_pi_abs is not None else None,
        "ratio": round(float(ratio), 4) if ratio is not None else None,
        "df_delta": round(float(df_delta), 4) if df_delta is not None else None,
        "detail": detail,
        "confidence": confidence,
    }


def _collect_caveats(organism_class, validity, findings, reference):
    caveats: list[str] = []

    if organism_class == "cyanobacteria":
        caveats.append(
            "Cyanobacteria: apparent Fv/Fm = (FM − Fin)/FM is NOT the true PSII quantum yield. "
            "Fin is inflated by phycobilisome and PSI fluorescence. "
            "Standard JIP-test health thresholds (calibrated for vascular plants) must not be applied."
        )
        caveats.append(
            "Cyanobacteria exist in State II in the dark (σII reduced), which underestimates FM. "
            "A correct FM requires far-red or weak-blue pre-illumination to induce State I."
        )
        caveats.append(
            "A partially-to-fully reduced dark PQ pool is normal for cyanobacteria "
            "(respiratory NDH-1/SDH). Treat VJ as a state indicator, not a stress index, "
            "unless a reference shows a significant shift."
        )

    elif organism_class in (None, "unknown"):
        caveats.append(
            "Organism class unknown — all confidence levels are conservative. "
            "Standard JIP-test thresholds (calibrated for vascular plants) may not apply. "
            "Provide organism_class for organism-appropriate interpretation."
        )

    if reference is None:
        caveats.append(
            "No reference / control sample provided. "
            "JIP-test parameters are comparative, not absolute (Tsimilli-Michael 2020). "
            "Without a reference, findings are indicative ('consistent with…') rather than diagnostic. "
            "PI and band (K-band, L-band) analyses are unavailable."
        )

    if not validity.get("acquisition_valid", True):
        caveats.append(
            "One or more acquisition validity gates failed. "
            "PQ-redox poise and quantum yield confidences are capped at LOW. "
            "VJ may reflect technical artifacts (SP intensity, culture density, instrument) "
            "rather than true redox state. See validity.blocking_issues."
        )

    if not validity.get("within_physiological_limits", True):
        caveats.append(
            "Sample appears outside physiological limits (dominant K-step, strongly suppressed FM). "
            "Derived parameters lose quantitative biophysical meaning beyond this threshold."
        )

    # Y(NA) confounding caveat — always relevant
    caveats.append(
        "VJ-based PQ-redox interpretation can be confounded by PSI acceptor-side limitation "
        "(Y(NA)). If the IP phase is absent or anomalous, VJ may not reliably reflect "
        "PQ-redox state (Zavřel et al. 2026)."
    )

    # High-light VJ' unreliability
    acclim = validity.get("acclimation") or ""
    if acclim == "light":
        caveats.append(
            "Sample was light-acclimated: VJ′ dynamic range narrows under high actinic light "
            "(>500 µmol photons m⁻² s⁻¹) and may not reliably report PQ-redox state "
            "(Zavřel et al. 2026)."
        )

    return caveats


# ─── Part 1 — primary public function ────────────────────────────────────────

def interpret_ojip(
    params: dict,
    organism_class: str | None = None,
    reference: dict | None = None,
    measurement: dict | None = None,
) -> dict:
    """
    Rule-based biological interpretation of JIP-test parameters.

    Parameters
    ----------
    params : dict
        Computed JIP-test parameters from the OJIP analysis pipeline.
        Expected keys (subset): F0 (or Fin), FM (or Fmax), FK, FJ, FI, FV,
        VJ, VI, M0, FVFM, PSIE0, PSIR0, DELTAR0, PHIE0, PHIR0,
        ABSRC, TR0RC, ET0RC, RE0RC, DI0RC, SM, N,
        Area_OJ, Area_JI, Area_IP, Area_OP.
    organism_class : str | None
        One of 'cyanobacteria', 'green_alga', 'plant', 'unknown', or None.
    reference : dict | None
        Optional control-sample parameter dict (same keys as params).
        When present, enables comparative analysis (K-band, L-band, PIabs ratio).
    measurement : dict | None
        Optional acquisition metadata.  Recognised keys (all optional):
        instrument (str), uses_measuring_light (bool),
        sp_intensity_umol (float), culture_density (float),
        acclimation ('dark'|'light'|'partial_dark'),
        dcmu (bool), fj_timing_ms (float).

    Returns
    -------
    dict  — structured findings (see module docstring for schema).
    """
    m = measurement or {}

    # Normalise organism class
    oc = organism_class
    if isinstance(oc, str):
        oc = oc.strip().lower()
        if oc in ("", "unknown"):
            oc = "unknown"
    else:
        oc = None

    # ── validity gates (must run first) ──────────────────────────────────────
    validity = _run_validity_gates(params, m)

    # Extra validity flags for cyanobacteria
    if oc == "cyanobacteria":
        validity["f0_is_true_f0"] = False
        validity["notes"].append(
            "Fin (labelled F0 in JIP-test) is NOT the true F0 for cyanobacteria: "
            "phycobilisome + PSI fluorescence inflate the initial signal."
        )

    # ── shape flags ───────────────────────────────────────────────────────────
    shape_flags = _compute_shape_flags(params, oc, validity, reference)

    # ── individual findings ───────────────────────────────────────────────────
    findings = {
        "pq_redox_poise":        _pq_redox_poise(params, oc, m, validity, shape_flags, reference),
        "psii_max_quantum_yield": _psii_max_quantum_yield(params, oc, validity),
        "electron_transport_qa": _electron_transport_qa(params, oc, validity, shape_flags),
        "initial_slope_m0":      _initial_slope_m0(params, oc, validity),
        "pq_pool_reduction":     _pq_pool_reduction(params, oc, validity),
        "psi_acceptor_side":     _psi_acceptor_side(params, oc, validity, shape_flags),
        "donor_side_oec":        _donor_side_oec(params, oc, validity, shape_flags, reference),
        "antenna_and_rcs":       _antenna_and_rcs(params, oc, validity),
        "energetic_connectivity": _energetic_connectivity(params, oc, validity, reference),
        "overall_performance":   _overall_performance(params, oc, validity, reference),
    }

    caveats = _collect_caveats(oc, validity, findings, reference)

    return {
        "organism_class":  oc or "unknown",
        "reference_used":  reference is not None,
        "validity":        validity,
        "findings":        findings,
        "shape_flags":     shape_flags,
        "caveats":         caveats,
    }


# ─── Part 2 — LLM narrative (optional, graceful) ─────────────────────────────

def generate_narrative(
    findings: dict,
    params: dict,
    reference: dict | None = None,
) -> str | None:
    """
    Generate a 3–5 sentence plain-language interpretation using the Gemini API.

    Returns None (without raising) if:
      - GEMINI_API_KEY env var is absent
      - the HTTP call fails for any reason
      - the response is empty or malformed

    Only named parameter values and structured rule-engine output are sent;
    raw transients and file contents are never transmitted.
    """
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None

    oc = findings.get("organism_class", "unknown")
    ref_used = findings.get("reference_used", False)
    validity = findings.get("validity", {})
    fgs = findings.get("findings", {})
    shape_flags = findings.get("shape_flags", [])
    caveats = findings.get("caveats", [])

    # ── assemble key scalars (named values only) ──────────────────────────────
    kv: dict[str, object] = {}
    for key in ("FVFM", "VJ", "VI", "M0", "PSIE0", "DELTAR0", "ABSRC",
                "TR0RC", "ET0RC", "RE0RC", "PHIE0", "PHIR0", "SM", "N"):
        v = _sf(params.get(key))
        if v is not None:
            kv[key] = round(v, 4)

    params_text = "; ".join(f"{k}={v}" for k, v in kv.items()) or "(none available)"

    # ── summarise findings as text ────────────────────────────────────────────
    findings_lines: list[str] = []
    for fname, fdata in fgs.items():
        if not isinstance(fdata, dict) or not fdata.get("available", True):
            continue
        driver = fdata.get("driver", "")
        detail = fdata.get("detail", "")
        conf = fdata.get("confidence", "")
        if detail:
            findings_lines.append(
                f"[{fname}] (confidence={conf}; driver={driver}): {detail}"
            )

    findings_text = "\n".join(findings_lines) or "(no findings generated)"
    caveats_text = "\n".join(f"- {c}" for c in caveats) or "(none)"
    flags_text = ", ".join(shape_flags) or "none"

    prompt = f"""You are assisting a photosynthesis researcher who has analysed a chlorophyll a
fluorescence OJIP transient using the JIP-test.  Your task is to write a concise,
3–5 sentence plain-language interpretation for the researcher.

Context:
- Measurement type: fast chlorophyll a fluorescence induction (OJIP / Kautsky) transient.
- Organism class: {oc}
- Reference/control used: {ref_used}
- Shape flags detected: {flags_text}

Key named parameter values (do NOT guess values not listed here):
{params_text}

Rule-engine findings (trust these; do not contradict them):
{findings_text}

Important organism-specific caveats to HONOUR:
{caveats_text}

INSTRUCTIONS:
1. Write 3–5 sentences only; plain language suitable for a photosynthesis expert.
2. Cite which parameter drives each conclusion (e.g. "VJ = 0.42 indicates…").
3. For cyanobacteria: do NOT treat Fv/Fm as a true quantum yield (it is PBS/PSI-confounded);
   do NOT call a high VJ 'stress' unless the reference shows a significant shift —
   a partially reduced dark PQ pool is normal for cyanobacteria.
4. When no reference is present: frame as 'consistent with…', not 'the sample is healthy/stressed'.
5. Do NOT speculate beyond the listed parameters.
6. Do NOT assign absolute health without a reference.
7. Respond with the interpretation text only — no markdown headers, no bullet points.
"""

    try:
        import requests as _req  # noqa: PLC0415  # type: ignore[import-untyped]
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            "gemini-2.0-flash:generateContent"
        )
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "maxOutputTokens": 512,
                "candidateCount": 1,
            },
        }
        resp = _req.post(url, json=payload, timeout=20,
                         headers={"x-goog-api-key": api_key})
        resp.raise_for_status()
        data = resp.json()
        text = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
            .strip()
        )
        return text if text else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Gemini narrative generation failed: %s", exc)
        return None


# ─── Part 3 — Template-based fallback narrative ───────────────────────────────

def summarise_findings(findings: dict, suppress_no_ref_caveat: bool = False) -> str:
    """
    Build a 2–4 sentence plain-language summary purely from the findings dict.
    No API call; always works offline.  Organism-aware; uses comparative framing.

    suppress_no_ref_caveat: set True when this call is for a standalone sub-narrative
    inside a comparative run (so the "no reference provided" sentence is omitted).
    """
    oc = findings.get("organism_class", "unknown")
    ref_used = findings.get("reference_used", False)
    fgs = findings.get("findings", {})
    shape_flags = findings.get("shape_flags", [])
    validity = findings.get("validity", {})
    caveats = findings.get("caveats", [])
    acq_valid = validity.get("acquisition_valid", True)
    within_phys = validity.get("within_physiological_limits", True)

    sentences: list[str] = []

    # ── sentence 1: organism context ─────────────────────────────────────────
    if oc == "cyanobacteria":
        sentences.append(
            "The sample was identified as a cyanobacterium; apparent Fv/Fm is phycobilisome- and "
            "PSI-confounded and is not the true PSII quantum yield."
        )
    elif oc == "green_alga":
        sentences.append("The sample was identified as a green alga.")
    elif oc == "plant":
        sentences.append("The sample was identified as a vascular plant.")
    else:
        sentences.append(
            "Organism class was not specified; standard JIP-test thresholds "
            "(calibrated for vascular plants) may not be appropriate."
        )

    # ── sentence 2: PQ-redox poise (primary) ─────────────────────────────────
    pq = fgs.get("pq_redox_poise", {})
    if pq.get("available"):
        poise = pq.get("poise", "")
        vj_val = pq.get("value")
        vj_label = pq.get("driver", "VJ")
        conf = pq.get("confidence", "moderate")
        poise_map = {
            "oxidised":          "well oxidised",
            "balanced":          "balanced",
            "partially_reduced": "partially reduced",
            "slightly_reduced":  "slightly reduced",
            "reduced":           "reduced",
            "severely_reduced":  "severely reduced (OJ-like profile)",
        }
        poise_text = poise_map.get(poise, poise)
        vj_str = f" ({vj_label} = {vj_val:.3f})" if vj_val is not None else ""
        cyano_ctx = (
            " which is the normal cyanobacterial dark baseline (respiratory NDH-1/SDH activity)"
            if (oc == "cyanobacteria" and poise in ("partially_reduced", "reduced", "severely_reduced"))
            else ""
        )
        conf_tag = " (low confidence — see acquisition warnings)" if conf == "low" else ""
        sentences.append(
            f"The PQ-pool redox poise is {poise_text}{vj_str}{cyano_ctx}{conf_tag}."
        )
    elif pq.get("note"):
        sentences.append(f"PQ-redox poise: {pq['note']}")

    # ── sentence 3: PSII quantum yield ───────────────────────────────────────
    psii = fgs.get("psii_max_quantum_yield", {})
    if psii.get("available") and psii.get("level") != "not_applicable":
        level = psii.get("level", "")
        fvfm_val = psii.get("value")
        fvfm_str = f" (Fv/Fm = {fvfm_val:.3f})" if fvfm_val is not None else ""
        level_map = {
            "ok":       "within the healthy reference range",
            "mild":     "mildly below the healthy baseline (mild photoinhibition possible)",
            "moderate": "moderately reduced (significant photoinhibition / stress)",
            "severe":   "severely reduced (PSII damage / OEC inactivation likely)",
        }
        level_text = level_map.get(level, level)
        sentences.append(
            f"Maximum PSII quantum yield is {level_text}{fvfm_str}."
        )
    elif oc == "cyanobacteria" and psii.get("available"):
        fvfm_val = psii.get("value")
        fvfm_str = f" = {fvfm_val:.3f}" if fvfm_val is not None else ""
        sentences.append(
            f"Apparent Fv/Fm{fvfm_str} cannot be interpreted with standard thresholds "
            "in cyanobacteria; it reflects PBS/PSI fluorescence contributions."
        )

    # ── sentence 4: donor side / OEC ─────────────────────────────────────────
    oec = fgs.get("donor_side_oec", {})
    if oec.get("available") and oec.get("level") == "impaired":
        w_ok = oec.get("w_ok")
        w_str = f" (W_OJ = {w_ok:.3f})" if w_ok is not None else ""
        sentences.append(
            f"A K-step is present{w_str}, suggesting OEC inactivation (heat or drought stress)."
        )

    # ── shape flags / IP suppressed ───────────────────────────────────────────
    if "IP_suppressed" in shape_flags:
        sentences.append(
            "The IP phase (I→P) is suppressed, indicating limited electron flow to "
            "PSI terminal acceptors; this may reflect dark FNR inactivation or PSI limitation."
        )

    # ── reference framing ─────────────────────────────────────────────────────
    if not ref_used and not suppress_no_ref_caveat:
        sentences.append(
            "No reference sample was provided; findings are indicative and framed as "
            "'consistent with' rather than diagnostic — comparative analysis with a "
            "control is required for definitive interpretation."
        )

    # ── validity warning ──────────────────────────────────────────────────────
    if not acq_valid and validity.get("blocking_issues"):
        issues = "; ".join(validity["blocking_issues"][:2])
        sentences.append(
            f"Acquisition validity concerns were detected ({issues}); "
            "PQ-redox and yield confidences are reduced to low."
        )

    return "  ".join(sentences[:5])  # cap at ~5 sentences


# ─────────────────────────────────────────────────────────────────────────────
# compare_ojip_params — rule-based comparative narrative
# ─────────────────────────────────────────────────────────────────────────────

def compare_ojip_params(
    sample: dict,
    reference: dict,
    organism_class: str | None = None,
) -> str:
    """
    Build a rule-based narrative paragraph (2–5 sentences) summarising what
    changed in *sample* relative to *reference*, based on JIP-test parameters.

    Both dicts use the same key convention as ``interpret_ojip`` params:
    FVFM, VJ, VI, M0, PSIE0, PSIR0, DELTAR0, PHIE0, PHIR0,
    ABSRC, TR0RC, ET0RC, RE0RC, DI0RC, SM, N, F0, FM, FK, FJ, FI, FV,
    Area_OJ, Area_JI, Area_IP, Area_OP.
    """

    def _g(d: dict, key: str) -> float | None:
        v = d.get(key)
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    def _delta(key: str) -> tuple[float | None, float | None]:
        """Returns (absolute_delta, percent_delta) or (None, None)."""
        sv = _g(sample, key)
        rv = _g(reference, key)
        if sv is None or rv is None:
            return None, None
        delta = sv - rv
        pct = (delta / abs(rv) * 100) if rv != 0 else None
        return delta, pct

    def _sig(key: str, thresh: float = 5.0) -> bool:
        _, pct = _delta(key)
        return pct is not None and abs(pct) > thresh

    def _pct_str(pct: float | None) -> str:
        if pct is None:
            return ''
        sign = '+' if pct >= 0 else ''
        return f'{sign}{pct:.1f}%'

    sentences: list[str] = []

    # Pre-compute all deltas used across multiple sections
    fvfm_d,   fvfm_pct   = _delta('FVFM')
    vj_d,     vj_pct     = _delta('VJ')
    m0_d,     m0_pct     = _delta('M0')
    psie_d,   psie_pct   = _delta('PSIE0')
    phie_d,   phie_pct   = _delta('PHIE0')
    psir_d,   psir_pct   = _delta('PSIR0')
    deltar_d, deltar_pct = _delta('DELTAR0')
    phir_d,   phir_pct   = _delta('PHIR0')
    rerc_d,   rerc_pct   = _delta('RE0RC')
    absrc_d,  absrc_pct  = _delta('ABSRC')
    dirc_d,   dirc_pct   = _delta('DI0RC')
    sm_d,     sm_pct     = _delta('SM')
    n_d,      n_pct      = _delta('N')
    aip_d,    aip_pct    = _delta('Area_IP')
    fj_d,     fj_pct     = _delta('FJ_time_user_ms')
    fi_d,     fi_pct     = _delta('FI_time_user_ms')
    fp_d,     fp_pct     = _delta('FM_time_ms')

    rv_fvfm = _g(reference, 'FVFM')
    sv_fvfm = _g(sample,    'FVFM')

    # ── 1. Lead: Fv/Fm ───────────────────────────────────────────────────────
    if rv_fvfm is not None and sv_fvfm is not None:
        if fvfm_pct is not None and abs(fvfm_pct) > 2 and fvfm_d is not None:
            verb = 'improved' if fvfm_d > 0 else 'declined'
            qualifier = (
                ' markedly' if abs(fvfm_pct) > 15 else
                ' noticeably' if abs(fvfm_pct) > 7 else ''
            )
            sentences.append(
                f'Fv/Fm{qualifier} {verb} from {rv_fvfm:.3f} to {sv_fvfm:.3f} '
                f'({_pct_str(fvfm_pct)}), indicating '
                f'{"enhanced" if fvfm_d > 0 else "reduced"} PSII photochemical efficiency.'
            )
        else:
            sentences.append(
                f'Fv/Fm was essentially unchanged ({rv_fvfm:.3f} vs {sv_fvfm:.3f}), '
                'suggesting no major shift in overall PSII photochemical efficiency.'
            )

    # ── 2. QA closure and PQ-pool redox (VJ, M₀) ─────────────────────────────
    vj_sig = vj_pct is not None and abs(vj_pct) > 5
    m0_sig = m0_pct is not None and abs(m0_pct) > 10

    if vj_sig or m0_sig:
        parts: list[str] = []
        if vj_sig and vj_d is not None:
            parts.append(
                f'{"greater" if vj_d > 0 else "less"} QA⁻ accumulation at the J-step '
                f'(VJ {_pct_str(vj_pct)}), indicating a more '
                f'{"reduced" if vj_d > 0 else "oxidised"} PQ pool '
                '(assuming similar PSI acceptor-side conditions)'
            )
        if m0_sig and m0_d is not None:
            parts.append(
                f'{"faster" if m0_d > 0 else "slower"} initial QA reduction '
                f'(M₀ {_pct_str(m0_pct)})'
            )
        if parts:
            sentences.append('The J-step region showed ' + '; and '.join(parts) + '.')

    # ── 2b. VJ near 1 — OJ-profile collapse ──────────────────────────────────
    sv_vj = _g(sample, 'VJ')
    rv_vj = _g(reference, 'VJ')
    vj_critical = sv_vj is not None and sv_vj >= 0.90

    if vj_critical:
        ref_clause = (
            f' (reference VJ = {rv_vj:.3f})'
            if rv_vj is not None else ''
        )
        sentences.append(
            f'VJ = {sv_vj:.3f} in the sample{ref_clause} — critically close to 1. '
            'At this level the OJIP transient approaches an OJ profile and ψE₀ ≈ '
            f'{max(0.0, 1.0 - (sv_vj or 0.0)):.3f}, meaning virtually no electrons proceed beyond QA. '
            'Two mechanistically opposite states can produce this signature: '
            '(a) complete over-reduction of the PQ pool — electrons back up at QA because '
            'downstream acceptors are saturated, PQ remains reduced; or '
            '(b) inhibition of QA⁻→QB transfer itself (DCMU-like: QB-binding herbicides, '
            'heat-damaged D1 protein, severe anoxia) — electrons are trapped at QA while '
            'the PQ pool stays oxidised because electrons cannot reach it. '
            'In both cases the J-I and I-P phases are absent or negligible; '
            'distinguishing the two requires additional information (e.g. PQ redox assay, '
            'inhibitor history, or far-red pre-illumination test).'
        )
    elif sv_vj is not None and sv_vj >= 0.80 and rv_vj is not None and rv_vj < 0.70:
        # Approaching critical range vs. a normal reference
        sentences.append(
            f'VJ rose to {sv_vj:.3f} (from {rv_vj:.3f} in reference), approaching the '
            'critically high range. Electron flow beyond QA is strongly suppressed '
            f'(ψE₀ ≈ {max(0.0, 1.0 - sv_vj):.3f}); the J-I phase is compressed.'
        )

    # ── 3. Electron transport beyond QA — PSII → PQ side (ψE₀, φE₀, ET₀/RC) ─
    psie_sig = psie_pct is not None and abs(psie_pct) > 5
    phie_sig = phie_pct is not None and abs(phie_pct) > 5
    etrc_d,  etrc_pct  = _delta('ET0RC')
    etrc_sig = etrc_pct is not None and abs(etrc_pct) > 10

    if psie_sig or phie_sig:
        lead_d    = psie_d if (abs(psie_pct or 0) >= abs(phie_pct or 0)) else phie_d
        direction = 'enhanced' if (lead_d is not None and lead_d > 0) else 'reduced'
        tags: list[str] = []
        if psie_sig:
            tags.append(f'ψE₀ {_pct_str(psie_pct)}')
        if phie_sig:
            tags.append(f'φE₀ {_pct_str(phie_pct)}')
        if etrc_sig:
            tags.append(f'ET₀/RC {_pct_str(etrc_pct)}')
        sentences.append(
            f'Electron transport probability from QA to PQ was {direction} ({", ".join(tags)}).'
        )

    # ── 4. PSI-side efficiency (δR₀, ψR₀, φR₀, RE₀/RC) ─────────────────────
    # Suppressed when VJ ≈ 1: δR₀ = ψR₀/ψE₀ diverges as ψE₀ → 0 (numerical artefact)
    deltar_sig = deltar_pct is not None and abs(deltar_pct) > 10
    psir_sig   = psir_pct   is not None and abs(psir_pct)   > 10
    phir_sig   = phir_pct   is not None and abs(phir_pct)   > 10
    rerc_sig   = rerc_pct   is not None and abs(rerc_pct)   > 10

    if vj_critical:
        sentences.append(
            'When VJ ≈ 1, δR₀ = ψR₀/ψE₀ diverges as ψE₀ → 0, making it a mathematical '
            'artefact rather than a biological measure. Other parameters derived from the '
            'J-I and I-P phases (Sm, N, Area I-P) collapse toward zero because the transient '
            'approaches a flat OJ profile — they are uninformative rather than divergent.'
        )
    elif deltar_sig or psir_sig or phir_sig or rerc_sig:
        lead_d = next(
            (d for d, s in [
                (deltar_d, deltar_sig), (psir_d, psir_sig),
                (phir_d, phir_sig), (rerc_d, rerc_sig),
            ] if s),
            None,
        )
        direction = 'improved' if (lead_d is not None and lead_d > 0) else 'impaired'
        tags = []
        if deltar_sig:
            tags.append(f'δR₀ {_pct_str(deltar_pct)}')
        if psir_sig:
            tags.append(f'ψR₀ {_pct_str(psir_pct)}')
        if phir_sig:
            tags.append(f'φR₀ {_pct_str(phir_pct)}')
        if rerc_sig:
            tags.append(f'RE₀/RC {_pct_str(rerc_pct)}')
        sentences.append(
            f'Electron transport efficiency to PSI terminal acceptors was {direction} '
            f'({", ".join(tags)}).'
        )

    # ── 4b. ψE₀↑ + δR₀↓ discordance — specific biological pattern ────────────
    if (not vj_critical
            and psie_sig and psie_d is not None and psie_d > 0
            and deltar_sig and deltar_d is not None and deltar_d < 0):
        sentences.append(
            'The combination of enhanced QA→PQ electron transport (ψE₀ ↑) with '
            'reduced downstream efficiency to PSI acceptors (δR₀ ↓) points to PSI '
            'acceptor-side limitation: electrons accumulate at the Fd/FNR pool rather '
            'than being re-exported to the Calvin cycle or alternative sinks.'
        )

    # ── 5. RC antenna balance / heat dissipation (ABS/RC, DI₀/RC) ────────────
    absrc_sig = absrc_pct is not None and abs(absrc_pct) > 10
    dirc_sig  = dirc_pct  is not None and abs(dirc_pct)  > 10

    if absrc_sig and absrc_d is not None:
        if absrc_d > 0:
            di_clause = (
                f', with heat dissipation per RC also rising (DI₀/RC {_pct_str(dirc_pct)})'
                if (dirc_sig and dirc_d is not None and dirc_d > 0) else ''
            )
            sentences.append(
                f'Antenna size per active RC (ABS/RC {_pct_str(absrc_pct)}) increased'
                f'{di_clause}, consistent with partial closure or inactivation of '
                'reaction centres.'
            )
        else:
            sentences.append(
                f'Antenna size per active RC (ABS/RC {_pct_str(absrc_pct)}) decreased, '
                'suggesting re-opening of previously closed reaction centres.'
            )
    elif dirc_sig and not absrc_sig and dirc_d is not None:
        direction = 'rose' if dirc_d > 0 else 'fell'
        sentences.append(
            f'Non-photochemical dissipation per RC (DI₀/RC) {direction} '
            f'({_pct_str(dirc_pct)}) without a proportional change in antenna size.'
        )

    # ── 6. PQ pool capacity and QA turnover (Sm, N) ───────────────────────────
    # Suppressed when VJ ≈ 1 (already noted in section 4 suppression message above)
    sm_sig = sm_pct is not None and abs(sm_pct) > 10
    n_sig  = n_pct  is not None and abs(n_pct)  > 10

    if not vj_critical and sm_sig and sm_d is not None:
        direction = 'expanded' if sm_d > 0 else 'contracted'
        n_clause = (
            f', with QA turnover number (N) also shifting by {_pct_str(n_pct)}'
            if n_sig else ''
        )
        sentences.append(
            f'The normalised PQ pool size (Sm) {direction} substantially '
            f'({_pct_str(sm_pct)}){n_clause}, indicating '
            f'{"greater electron acceptor capacity and increased overall electron flow" if sm_d > 0 else "reduced electron acceptor capacity"}.'
        )
    elif not vj_critical and n_sig and not sm_sig and n_d is not None:
        direction = 'increased' if n_d > 0 else 'decreased'
        sentences.append(
            f'QA turnover number (N) {direction} ({_pct_str(n_pct)}), '
            'reflecting a change in total electron acceptor cycling capacity.'
        )

    # ── 7. I-P phase (PSI acceptor-side area) ────────────────────────────────
    # Suppressed when VJ ≈ 1 (already noted in section 4 suppression message above)
    aip_sig = aip_pct is not None and abs(aip_pct) > 25

    if not vj_critical and aip_sig and aip_d is not None:
        direction = 'expanded' if aip_d > 0 else 'contracted'
        interp = (
            'indicating deeper reduction of PSI terminal acceptors (Fd, FNR, NADP⁺)'
            if aip_d > 0 else
            'indicating reduced electron flux to PSI terminal acceptors'
        )
        sentences.append(
            f'The I-P phase area {direction} markedly ({_pct_str(aip_pct)}), '
            f'{interp}.'
        )

    # ── 8. Phase timing (FJ, FI, FP) ─────────────────────────────────────────
    TIMING_THRESH = 15.0
    fj_rv = _g(reference, 'FJ_time_user_ms')
    fj_sv = _g(sample,    'FJ_time_user_ms')
    fi_rv = _g(reference, 'FI_time_user_ms')
    fi_sv = _g(sample,    'FI_time_user_ms')
    fp_rv = _g(reference, 'FM_time_ms')
    fp_sv = _g(sample,    'FM_time_ms')

    timing_parts: list[str] = []

    if fj_pct is not None and abs(fj_pct) > TIMING_THRESH and fj_d is not None:
        direction = 'earlier' if fj_d < 0 else 'later'
        speed     = 'faster'  if fj_d < 0 else 'slower'
        fj_str    = (f'{fj_rv:.2f} → {fj_sv:.2f} ms'
                     if fj_rv is not None and fj_sv is not None else '')
        timing_parts.append(
            f't(FJ) shifted {direction} ({fj_str}, {_pct_str(fj_pct)}), '
            f'indicating {speed} initial QA⁻ accumulation'
        )

    if fi_pct is not None and abs(fi_pct) > TIMING_THRESH and fi_d is not None:
        direction = 'earlier' if fi_d < 0 else 'later'
        interp    = 'stronger PSI electron sink' if fi_d < 0 else 'reduced PSI electron sink'
        fi_str    = (f'{fi_rv:.1f} → {fi_sv:.1f} ms'
                     if fi_rv is not None and fi_sv is not None else '')
        timing_parts.append(
            f't(FI) shifted {direction} ({fi_str}, {_pct_str(fi_pct)}), '
            f'suggesting {interp}'
        )

    if fp_pct is not None and abs(fp_pct) > TIMING_THRESH and fp_d is not None:
        direction = 'earlier' if fp_d < 0 else 'later'
        fp_str    = (f'{fp_rv:.0f} → {fp_sv:.0f} ms'
                     if fp_rv is not None and fp_sv is not None else '')
        # cross-reference with I-P area: if both enlarged, interpret together
        if aip_sig and aip_d is not None and aip_d > 0 and fp_d > 0:
            timing_parts.append(
                f't(FP) shifted {direction} ({fp_str}, {_pct_str(fp_pct)}); '
                'combined with the enlarged I-P area this reflects prolonged but '
                'deeper reduction of PSI terminal acceptors'
            )
        else:
            timing_parts.append(
                f't(FP) shifted {direction} ({fp_str}, {_pct_str(fp_pct)}), '
                f'indicating {"faster overall OJIP kinetics" if fp_d < 0 else "delayed downstream electron utilisation"}'
            )

    if timing_parts:
        sentences.append('Phase timing: ' + '; '.join(timing_parts) + '.')

    # ── Fallback: nothing significant ────────────────────────────────────────
    if not sentences:
        sentences.append(
            'No parameter changed by more than 5 % relative to the reference; '
            'the two OJIP curves are broadly comparable.'
        )

    return '  '.join(sentences)
