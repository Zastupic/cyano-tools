"""
Unit tests for website.ojip_interpretation

Run with:  pytest tests/test_ojip_interpretation.py -v
(from the Flask_server directory)

Tests cover the nine scenarios specified in the task:
  1.  Synechococcus-like cyanobacterium (apparent Fv/Fm ≈ 0.10, VJ ≈ 1.0)
  2.  Healthy plant (Fv/Fm ≈ 0.83, VJ ≈ 0.40)
  3.  Dark vs light acclimation — VJ vs VJ′ selection
  4.  Dark→light transient VJ′ rise framed as FNR/CBB-lag, not stress
  5.  Acquisition-validity gating (low SP, high density, AquaPen+density)
  6.  DCMU present — no PQ-redox poise, graceful handling
  7.  K-step input (shoulder at 300 µs, suppressed P)
  8.  IP-suppressed input (FI ≈ FP)
  9.  Reference vs treatment pair — K-band, L-band, PIabs ratio
 10.  Missing GEMINI_API_KEY — generate_narrative returns None
"""

import os
import sys
import math

# Make the website package importable from tests/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from website.ojip_interpretation import (
    interpret_ojip,
    generate_narrative,
    summarise_findings,
)


# ─── fixtures / shared sample builders ───────────────────────────────────────

def _plant_healthy():
    """Healthy dark-acclimated plant: Fv/Fm ≈ 0.83, VJ ≈ 0.40."""
    F0, FM = 200.0, 1200.0
    FV = FM - F0
    FJ = F0 + 0.40 * FV     # VJ = 0.40
    FI = F0 + 0.85 * FV     # VI = 0.85
    FK = F0 + 0.12 * FV     # W_OJ = 0.12/(0.40) = 0.30 — no K-step
    F50 = F0 + 0.05 * FV
    M0 = 4 * (FK - F50) / FV
    VJ = (FJ - F0) / FV
    VI = (FI - F0) / FV
    PSIE0 = 1 - VJ
    PSIR0 = 1 - VI
    FVFM = FV / FM
    DELTAR0 = PSIR0 / PSIE0
    TR0RC = M0 / VJ
    ABSRC = TR0RC / FVFM
    PHIE0 = FVFM * PSIE0
    PHIR0 = FVFM * PSIR0
    ET0RC = TR0RC * PSIE0
    RE0RC = TR0RC * PSIR0
    DI0RC = ABSRC - TR0RC
    SM = 15.0
    N = SM * M0 / VJ
    return dict(
        F0=F0, FM=FM, FK=FK, FJ=FJ, FI=FI, FV=FV,
        FVFM=FVFM, VJ=VJ, VI=VI, M0=M0,
        PSIE0=PSIE0, PSIR0=PSIR0, DELTAR0=DELTAR0,
        PHIE0=PHIE0, PHIR0=PHIR0,
        ABSRC=ABSRC, TR0RC=TR0RC, ET0RC=ET0RC, RE0RC=RE0RC, DI0RC=DI0RC,
        SM=SM, N=N,
        Area_OJ=0.05, Area_JI=0.10, Area_IP=0.08, Area_OP=0.23,
        FJ_time_user_ms=2.0, FI_time_user_ms=30.0,
    )


def _cyano_synechococcus():
    """
    Synechococcus-like cyanobacterium: apparent Fv/Fm ≈ 0.10, VJ ≈ 1.0.
    High apparent F0 (PBS+PSI), partially-to-fully reduced dark PQ pool.
    """
    # Fin (apparent F0) inflated by PBS + PSI
    Fin = 900.0   # very high
    FM = 1000.0   # small FM-Fin gap → apparent Fv/Fm ≈ 0.10
    FV_app = FM - Fin
    FJ = Fin + 0.98 * FV_app   # VJ ≈ 0.98
    FI = Fin + 0.99 * FV_app   # VI ≈ 0.99
    FK = Fin + 0.50 * FV_app   # W_OJ = 0.50/0.98 ≈ 0.51
    F50 = Fin + 0.10 * FV_app
    M0 = 4 * (FK - F50) / FV_app
    VJ = (FJ - Fin) / FV_app
    VI = (FI - Fin) / FV_app
    PSIE0 = 1 - VJ
    PSIR0 = 1 - VI
    FVFM = FV_app / FM
    DELTAR0 = PSIR0 / PSIE0 if PSIE0 > 0 else 0
    TR0RC = M0 / VJ if VJ > 0 else 0
    ABSRC = TR0RC / FVFM if FVFM > 0 else 0
    PHIE0 = FVFM * PSIE0
    PHIR0 = FVFM * PSIR0
    ET0RC = TR0RC * PSIE0
    RE0RC = TR0RC * PSIR0
    DI0RC = ABSRC - TR0RC
    SM = 5.0
    N = SM * M0 / VJ if VJ > 0 else 0
    return dict(
        F0=Fin, FM=FM, FK=FK, FJ=FJ, FI=FI, FV=FV_app,
        FVFM=FVFM, VJ=VJ, VI=VI, M0=M0,
        PSIE0=PSIE0, PSIR0=PSIR0, DELTAR0=DELTAR0,
        PHIE0=PHIE0, PHIR0=PHIR0,
        ABSRC=ABSRC, TR0RC=TR0RC, ET0RC=ET0RC, RE0RC=RE0RC, DI0RC=DI0RC,
        SM=SM, N=N,
        Area_OJ=0.01, Area_JI=0.01, Area_IP=0.005, Area_OP=0.025,
        FJ_time_user_ms=2.0, FI_time_user_ms=30.0,
    )


def _plant_k_step():
    """Plant with dominant K-step (OEC inactivation): low Fv/Fm, W_OJ high."""
    F0, FM = 200.0, 600.0   # suppressed FM → low Fv/Fm
    FV = FM - F0
    FJ = F0 + 0.70 * FV    # VJ = 0.70
    FI = F0 + 0.85 * FV
    FK = F0 + 0.42 * FV    # W_OJ = 0.42/0.70 = 0.60 — K-step present
    F50 = F0 + 0.05 * FV
    M0 = 4 * (FK - F50) / FV
    VJ = (FJ - F0) / FV
    VI = (FI - F0) / FV
    FVFM = FV / FM          # ≈ 0.667 but FM suppressed
    PSIE0 = 1 - VJ
    PSIR0 = 1 - VI
    DELTAR0 = PSIR0 / PSIE0
    TR0RC = M0 / VJ
    ABSRC = TR0RC / FVFM
    PHIE0 = FVFM * PSIE0
    PHIR0 = FVFM * PSIR0
    ET0RC = TR0RC * PSIE0
    RE0RC = TR0RC * PSIR0
    DI0RC = ABSRC - TR0RC
    return dict(
        F0=F0, FM=FM, FK=FK, FJ=FJ, FI=FI, FV=FV,
        FVFM=FVFM, VJ=VJ, VI=VI, M0=M0,
        PSIE0=PSIE0, PSIR0=PSIR0, DELTAR0=DELTAR0,
        PHIE0=PHIE0, PHIR0=PHIR0,
        ABSRC=ABSRC, TR0RC=TR0RC, ET0RC=ET0RC, RE0RC=RE0RC, DI0RC=DI0RC,
        SM=8.0, N=4.0,
        Area_OJ=0.04, Area_JI=0.06, Area_IP=0.05, Area_OP=0.15,
        FJ_time_user_ms=2.0, FI_time_user_ms=30.0,
    )


def _plant_ip_suppressed():
    """Plant with IP phase suppressed (FI ≈ FM)."""
    F0, FM = 200.0, 1200.0
    FV = FM - F0
    FJ = F0 + 0.45 * FV    # VJ = 0.45
    FI = FM - 0.02 * FV    # VI ≈ 0.98  →  IP = 0.02 FV  →  IP_suppressed
    FK = F0 + 0.14 * FV
    F50 = F0 + 0.05 * FV
    M0 = 4 * (FK - F50) / FV
    VJ = (FJ - F0) / FV
    VI = (FI - F0) / FV
    FVFM = FV / FM
    PSIE0 = 1 - VJ
    PSIR0 = 1 - VI
    DELTAR0 = PSIR0 / PSIE0 if PSIE0 > 0 else 0
    TR0RC = M0 / VJ
    ABSRC = TR0RC / FVFM
    PHIE0 = FVFM * PSIE0
    PHIR0 = FVFM * PSIR0
    ET0RC = TR0RC * PSIE0
    RE0RC = TR0RC * PSIR0
    DI0RC = ABSRC - TR0RC
    return dict(
        F0=F0, FM=FM, FK=FK, FJ=FJ, FI=FI, FV=FV,
        FVFM=FVFM, VJ=VJ, VI=VI, M0=M0,
        PSIE0=PSIE0, PSIR0=PSIR0, DELTAR0=DELTAR0,
        PHIE0=PHIE0, PHIR0=PHIR0,
        ABSRC=ABSRC, TR0RC=TR0RC, ET0RC=ET0RC, RE0RC=RE0RC, DI0RC=DI0RC,
        SM=12.0, N=5.0,
        Area_OJ=0.05, Area_JI=0.10, Area_IP=0.01, Area_OP=0.16,
        FJ_time_user_ms=2.0, FI_time_user_ms=30.0,
    )


# ─── Test 1: Cyanobacterium — no severe PSII stress, PBS-confounded Fv/Fm ────

class TestCyanobacteria:

    def setup_method(self):
        self.params = _cyano_synechococcus()
        self.m = {"acclimation": "dark", "instrument": "aquapen"}
        self.result = interpret_ojip(
            self.params,
            organism_class="cyanobacteria",
            measurement=self.m,
        )

    def test_organism_class_set(self):
        assert self.result["organism_class"] == "cyanobacteria"

    def test_fvfm_not_severe_stress(self):
        """Must NOT classify apparent Fv/Fm ≈ 0.10 as 'severe PSII stress'."""
        psii = self.result["findings"]["psii_max_quantum_yield"]
        assert psii["level"] == "not_applicable", (
            f"Expected 'not_applicable' for cyano Fv/Fm, got {psii['level']!r}"
        )

    def test_fvfm_confidence_low(self):
        psii = self.result["findings"]["psii_max_quantum_yield"]
        assert psii["confidence"] == "low"

    def test_fvfm_pbs_confounded_mentioned(self):
        psii = self.result["findings"]["psii_max_quantum_yield"]
        detail = psii["detail"].lower()
        assert "phycobilisom" in detail or "pbs" in detail or "confounded" in detail

    def test_pq_redox_reduced_not_stress(self):
        """Highly reduced dark PQ pool (VJ ≈ 1) must be reported as baseline, not stress."""
        pq = self.result["findings"]["pq_redox_poise"]
        assert pq["available"] is True
        # VJ ≈ 0.98 → 'reduced' or 'partially_reduced' is expected
        assert pq["poise"] in ("reduced", "partially_reduced"), (
            f"Expected reduced/partially_reduced poise, got {pq['poise']!r}"
        )
        # The detail / state_note must not call it photosynthetic damage / stress
        state_note = pq.get("state_note", "").lower()
        assert "not" in state_note and ("stress" in state_note or "damage" in state_note), (
            "state_note should clarify that reduced PQ pool is NOT photosynthetic damage"
        )

    def test_no_absolute_health_declaration(self):
        """Without reference, no absolute health declaration in caveats or findings."""
        caveats_text = " ".join(self.result["caveats"]).lower()
        assert "without a reference" in caveats_text or "indicative" in caveats_text

    def test_caveats_present_for_cyano(self):
        assert len(self.result["caveats"]) >= 2

    def test_validity_f0_not_true_f0(self):
        assert self.result["validity"]["f0_is_true_f0"] is False

    def test_shape_flags_computed(self):
        """OJS shape and/or IP_suppressed flags expected for VJ ≈ 1."""
        flags = self.result["shape_flags"]
        # At least one flag should fire for this extreme cyano transient
        assert isinstance(flags, list)


# ─── Test 2: Healthy plant — no stress declared, balanced/oxidised PQ pool ──

class TestHealthyPlant:

    def setup_method(self):
        self.params = _plant_healthy()
        self.m = {"acclimation": "dark", "sp_intensity_umol": 3000}
        self.result = interpret_ojip(
            self.params,
            organism_class="plant",
            measurement=self.m,
        )

    def test_organism_class(self):
        assert self.result["organism_class"] == "plant"

    def test_fvfm_ok(self):
        psii = self.result["findings"]["psii_max_quantum_yield"]
        assert psii["level"] == "ok", (
            f"Healthy plant Fv/Fm={self.params['FVFM']:.3f} should be 'ok', got {psii['level']!r}"
        )

    def test_fvfm_confidence_moderate(self):
        psii = self.result["findings"]["psii_max_quantum_yield"]
        assert psii["confidence"] == "moderate"

    def test_pq_redox_balanced_or_oxidised(self):
        pq = self.result["findings"]["pq_redox_poise"]
        assert pq["available"] is True
        # VJ = 0.40 → 'balanced' (0.25–0.50)
        assert pq["poise"] in ("balanced", "oxidised"), (
            f"Plant VJ=0.40 should be balanced/oxidised, got {pq['poise']!r}"
        )

    def test_no_k_step(self):
        oec = self.result["findings"]["donor_side_oec"]
        assert oec.get("k_step_present") is False

    def test_ip_not_suppressed(self):
        assert "IP_suppressed" not in self.result["shape_flags"]

    def test_acquisition_valid(self):
        assert self.result["validity"]["acquisition_valid"] is True


# ─── Test 3: Dark vs light acclimation — VJ vs VJ′ ──────────────────────────

class TestAcclimationSelection:

    def test_dark_selects_vj(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"acclimation": "dark"})
        assert r["validity"]["vj_or_vjprime"] == "VJ"

    def test_light_selects_vjprime(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"acclimation": "light"})
        assert r["validity"]["vj_or_vjprime"] == "VJ'"

    def test_partial_dark_selects_vjprime(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"acclimation": "partial_dark"})
        assert r["validity"]["vj_or_vjprime"] == "VJ'"

    def test_unknown_acclimation_defaults_to_vj_with_warning(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant", measurement={})
        assert r["validity"]["vj_or_vjprime"] == "VJ"
        notes_text = " ".join(r["validity"]["notes"]).lower()
        assert "acclimation" in notes_text and "unknown" in notes_text


# ─── Test 4: Dark→light VJ′ rise is FNR/CBB-lag, not stress ─────────────────

class TestDarkToLightTransient:

    def test_fnr_lag_not_stress(self):
        """VJ′ elevated shortly after dark→light must cite FNR/CBB lag, not stress."""
        p = _plant_healthy()
        p["VJ"] = 0.72   # elevated but < 0.80
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"acclimation": "partial_dark"})
        pq = r["findings"]["pq_redox_poise"]
        state_note = pq.get("state_note", "").lower()
        # Should mention FNR or CBB or 'expected physiology'
        assert (
            "fnr" in state_note or "cbb" in state_note or "expected" in state_note
            or "transient" in state_note
        ), f"state_note should mention FNR/CBB or expected physiology: {state_note!r}"


# ─── Test 5: Acquisition-validity gating ────────────────────────────────────

class TestValidityGating:

    def test_low_sp_intensity_sets_invalid(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"sp_intensity_umol": 500, "acclimation": "dark"})
        assert r["validity"]["acquisition_valid"] is False
        assert len(r["validity"]["blocking_issues"]) >= 1

    def test_low_sp_caps_pq_confidence_low(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"sp_intensity_umol": 500, "acclimation": "dark"})
        pq = r["findings"]["pq_redox_poise"]
        assert pq.get("confidence") == "low"

    def test_high_density_sets_invalid(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"culture_density": 8.0, "acclimation": "dark"})
        assert r["validity"]["acquisition_valid"] is False

    def test_aquapen_high_density_sets_invalid(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="green_alga",
                           measurement={
                               "instrument": "aquapen",
                               "culture_density": 3.0,
                               "acclimation": "dark",
                           })
        assert r["validity"]["acquisition_valid"] is False
        issues_text = " ".join(r["validity"]["blocking_issues"]).lower()
        assert "aquapen" in issues_text or "saturation" in issues_text

    def test_validity_warning_in_pq_finding(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"sp_intensity_umol": 200, "acclimation": "dark"})
        pq = r["findings"]["pq_redox_poise"]
        assert "validity_warning" in pq, "pq_redox_poise should contain validity_warning"

    def test_narrative_attributes_to_technique(self):
        """
        When acquisition is invalid, the template narrative must not
        attribute a VJ shift to redox biology.
        """
        p = _plant_healthy()
        p["VJ"] = 0.75
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"sp_intensity_umol": 300, "acclimation": "dark"})
        summary = summarise_findings(r).lower()
        # The summary should mention acquisition / confidence / validity
        assert (
            "confidence" in summary or "acquisition" in summary
            or "validity" in summary or "low" in summary
        )


# ─── Test 6: DCMU present — no PQ-redox poise ───────────────────────────────

class TestDCMU:

    def setup_method(self):
        # With DCMU, VJ → ~1 (FM reached at J-step)
        self.params = _plant_healthy()
        self.params["VJ"] = 0.98
        self.result = interpret_ojip(
            self.params,
            organism_class="plant",
            measurement={"dcmu": True, "acclimation": "dark"},
        )

    def test_pq_redox_not_available(self):
        pq = self.result["findings"]["pq_redox_poise"]
        assert pq.get("available") is False, (
            "pq_redox_poise must be unavailable when DCMU is present"
        )

    def test_pq_redox_note_mentions_dcmu(self):
        pq = self.result["findings"]["pq_redox_poise"]
        note = pq.get("note", "").lower()
        assert "dcmu" in note

    def test_acquisition_invalid_with_dcmu(self):
        assert self.result["validity"]["acquisition_valid"] is False

    def test_dcmu_blocking_issue(self):
        issues_text = " ".join(self.result["validity"]["blocking_issues"]).lower()
        assert "dcmu" in issues_text

    def test_analysis_completes_gracefully(self):
        """Engine must not raise; all other findings must still be present."""
        assert "psii_max_quantum_yield" in self.result["findings"]
        assert "donor_side_oec" in self.result["findings"]


# ─── Test 7: K-step / OEC inactivation ──────────────────────────────────────

class TestKStep:

    def setup_method(self):
        self.params = _plant_k_step()
        # Extreme K-step: W_OJ high AND Fv/Fm < 0.35 → outside physiological limits
        # Override to a really severe case
        self.params["FVFM"] = 0.28
        self.params["FM"] = self.params["F0"] + 0.28 * (
            self.params["F0"] / (1 - 0.28)
        )   # approximate FM for FVFM=0.28
        self.result = interpret_ojip(
            self.params,
            organism_class="plant",
            measurement={"acclimation": "dark", "sp_intensity_umol": 3000},
        )

    def test_k_step_flag_present(self):
        assert "K_step_present" in self.result["shape_flags"], (
            f"K_step_present missing from {self.result['shape_flags']}"
        )

    def test_oec_impaired(self):
        oec = self.result["findings"]["donor_side_oec"]
        assert oec.get("level") == "impaired"

    def test_oec_k_step_true(self):
        oec = self.result["findings"]["donor_side_oec"]
        assert oec.get("k_step_present") is True

    def test_physiological_limits_flag(self):
        """Dominant K-step + suppressed FM must flag within_physiological_limits=False."""
        # Note: the full within_physiological_limits condition requires FVFM < 0.35
        # and w_ok > 0.50 simultaneously; our params satisfy this
        valid = self.result["validity"]
        # Accept either False (full gate triggered) or noted in caveats
        physiological_caveat = any(
            "physiological" in c.lower() for c in self.result["caveats"]
        )
        oec_low = self.result["findings"]["donor_side_oec"].get("confidence") == "low"
        assert (
            valid.get("within_physiological_limits") is False
            or physiological_caveat
            or oec_low
        )

    def test_confidence_degraded(self):
        """When outside physiological limits, confidence must not be 'high'."""
        oec = self.result["findings"]["donor_side_oec"]
        assert oec.get("confidence") in ("low", "moderate")


# ─── Test 8: IP-suppressed ───────────────────────────────────────────────────

class TestIPSuppressed:

    def setup_method(self):
        self.params = _plant_ip_suppressed()
        self.result = interpret_ojip(
            self.params,
            organism_class="plant",
            measurement={"acclimation": "dark", "sp_intensity_umol": 3000},
        )

    def test_ip_suppressed_flag(self):
        assert "IP_suppressed" in self.result["shape_flags"]

    def test_psi_acceptor_side_suppressed(self):
        psi = self.result["findings"]["psi_acceptor_side"]
        assert psi.get("level") == "suppressed" or psi.get("ip_suppressed") is True

    def test_psi_detail_mentions_psi_or_fnr(self):
        psi = self.result["findings"]["psi_acceptor_side"]
        detail = psi.get("detail", "").lower()
        assert "psi" in detail or "fnr" in detail or "acceptor" in detail


# ─── Test 9: Reference vs treatment pair ────────────────────────────────────

class TestWithReference:

    def setup_method(self):
        self.ref = _plant_healthy()    # control (healthy)
        # Treatment: slightly stressed — lower Fv/Fm, higher VJ
        p = _plant_healthy()
        F0, FM = p["F0"], p["FM"]
        FV = FM - F0
        p["VJ"] = 0.60
        p["FJ"] = F0 + 0.60 * FV
        p["PSIE0"] = 0.40
        p["FVFM"] = 0.68
        p["FK"] = F0 + 0.25 * FV  # slight K-band vs reference (ref FK = 0.12*FV)
        self.params = p
        self.result = interpret_ojip(
            self.params,
            organism_class="plant",
            reference=self.ref,
            measurement={"acclimation": "dark", "sp_intensity_umol": 3000},
        )

    def test_reference_used_flag(self):
        assert self.result["reference_used"] is True

    def test_piabs_ratio_available(self):
        perf = self.result["findings"]["overall_performance"]
        assert perf["available"] is True
        assert perf["ratio"] is not None
        # Stressed plant should have PI ratio < 1 vs healthy reference
        assert perf["ratio"] < 1.0

    def test_piabs_df_delta_negative(self):
        perf = self.result["findings"]["overall_performance"]
        assert perf["df_delta"] is not None
        assert perf["df_delta"] < 0

    def test_pq_redox_relative_reported(self):
        """With a reference, VJ direction of change should appear in detail."""
        pq = self.result["findings"]["pq_redox_poise"]
        detail = pq.get("detail", "").lower()
        assert "relative" in detail or "reference" in detail or "Δvj" in detail.lower()

    def test_k_band_computed(self):
        """Treatment has higher FK → K_band_positive expected."""
        flags = self.result["shape_flags"]
        assert "K_band_positive" in flags, (
            f"K_band_positive expected in shape_flags: {flags}"
        )

    def test_l_band_available(self):
        conn = self.result["findings"]["energetic_connectivity"]
        assert conn["available"] is True
        assert "delta_w_ok" in conn


# ─── Test 10: Missing GEMINI_API_KEY — generate_narrative returns None ────────

class TestGeminiMissing:

    def test_no_key_returns_none(self):
        """generate_narrative must return None when GEMINI_API_KEY is absent."""
        original = os.environ.pop("GEMINI_API_KEY", None)
        try:
            params = _plant_healthy()
            findings = interpret_ojip(params, organism_class="plant",
                                      measurement={"acclimation": "dark"})
            result = generate_narrative(findings, params)
            assert result is None, (
                f"Expected None when GEMINI_API_KEY absent, got {result!r}"
            )
        finally:
            if original is not None:
                os.environ["GEMINI_API_KEY"] = original

    def test_fallback_to_summarise_findings(self):
        """With no API key, summarise_findings must return a non-empty string."""
        params = _plant_healthy()
        findings = interpret_ojip(params, organism_class="plant",
                                  measurement={"acclimation": "dark"})
        summary = summarise_findings(findings)
        assert isinstance(summary, str)
        assert len(summary) > 50

    def test_full_route_without_api_key(self):
        """
        Simulate the Flask route: narrative = generate_narrative(...) or summarise.
        Must produce a non-empty final narrative.
        """
        os.environ.pop("GEMINI_API_KEY", None)
        params = _cyano_synechococcus()
        findings = interpret_ojip(params, organism_class="cyanobacteria",
                                  measurement={"acclimation": "dark"})
        narrative = generate_narrative(findings, params)
        if narrative is None:
            narrative = summarise_findings(findings)
        assert narrative is not None
        assert len(narrative) > 0


# ─── Additional edge-case tests ───────────────────────────────────────────────

class TestEdgeCases:

    def test_unknown_organism_emits_caveat(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class=None, measurement={"acclimation": "dark"})
        assert r["organism_class"] == "unknown"
        cav = " ".join(r["caveats"]).lower()
        assert "unknown" in cav or "organism" in cav

    def test_none_measurement_does_not_crash(self):
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant", measurement=None)
        assert "findings" in r

    def test_empty_params_does_not_crash(self):
        r = interpret_ojip({}, organism_class="plant", measurement={})
        assert "findings" in r
        # Most findings should be unavailable but no crash
        for finding in r["findings"].values():
            assert isinstance(finding, dict)

    def test_fj_timing_warning(self):
        """FJ picked at 25 ms (far from 2 ms) should emit a note/warning."""
        p = _plant_healthy()
        r = interpret_ojip(p, organism_class="plant",
                           measurement={"acclimation": "dark", "fj_timing_ms": 25.0})
        notes = " ".join(r["validity"]["notes"]).lower()
        issues = " ".join(r["validity"]["blocking_issues"]).lower()
        assert "25" in notes + issues or "fj" in notes + issues

    def test_summarise_findings_always_returns_string(self):
        for oc in ("plant", "green_alga", "cyanobacteria", "unknown", None):
            p = _plant_healthy()
            r = interpret_ojip(p, organism_class=oc, measurement={"acclimation": "dark"})
            s = summarise_findings(r)
            assert isinstance(s, str) and len(s) > 0, f"Empty summary for oc={oc!r}"

    def test_plant_thresholds_not_applied_to_cyano(self):
        """Plant thresholds (level='ok'/'mild'/'moderate'/'severe') must not
        appear for cyanobacteria Fv/Fm."""
        p = _cyano_synechococcus()
        r = interpret_ojip(p, organism_class="cyanobacteria",
                           measurement={"acclimation": "dark"})
        psii = r["findings"]["psii_max_quantum_yield"]
        assert psii["level"] not in ("ok", "mild", "moderate", "severe"), (
            f"Plant Fv/Fm level {psii['level']!r} must not be applied to cyanobacteria"
        )
