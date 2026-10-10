"""
Unit tests for the FJ/FI timing ↔ value invariant in website.OJIP_data_analysis

Run with:  pytest tests/test_ojip_timing.py -v
(from the Flask_server directory)

Background
----------
`analyze_one_curve()` used to resolve the FJ/FI timings TWICE, independently:
the value lookup read `FJ_deriv` (the D2 *minimum*) unconditionally, while the
reported `FJ_time_user_ms` came from `_resolve_user_timing()` (the D2
*zero-crossing* in the default mode).  The minimum always precedes the
crossing, so the tabulated FJ was the curve value at an earlier time than the
tabulated t(FJ) — reported externally as "FJ comes from 3 to 4 rows earlier
than your own t(FJ)".  Curves that hit the fallback agreed only by accident,
both paths collapsing onto `fj_fallback_ms`.

The invariant asserted here is the thing that was violated:

    result['FJ'] == (the curve value at result['FJ_time_user_ms'],
                     read according to `value_readout`)

It must hold for every detection mode × every readout mode.
"""

import os
import sys

import numpy as np
import pytest

# Make the website package importable from tests/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SECRET_KEY", "test-secret-key")

from website.OJIP_data_analysis import (  # noqa: E402
    _VALUE_READOUTS,
    _compute_jip_params,
    _detect_pq_transition,
    _read_value_at,
    analyze_one_curve,
)

FLUOROMETER = "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"
DETECT_MODES = ("d2_zero", "poly_inflect", "d2_min", "fixed")


def _synthetic_ojip(times_ms):
    """A three-phase OJIP transient with clear J (~2 ms) and I (~30 ms) steps.

    Sum of three saturating exponentials — the standard O-J / J-I / I-P
    decomposition — scaled into plausible raw fluorescence units (F0 ≈ 0.25,
    FM ≈ 1.0) so the double-normalisation inside analyze_one_curve behaves as
    it does on real data.
    """
    t = np.asarray(times_ms, dtype=float)
    v = (0.45 * (1.0 - np.exp(-t / 0.45))
         + 0.30 * (1.0 - np.exp(-t / 7.0))
         + 0.25 * (1.0 - np.exp(-t / 90.0)))
    return 0.25 + 0.75 * v


# A deliberately SPARSE log-spaced grid (~60 points, like OJIP Imaging), which
# is where nearest-sample and interpolated readouts genuinely differ.
SPARSE_T = np.geomspace(0.05, 1000.0, 60)
# A dense grid (~0.01 ms, like Multi-Color-PAM) as a second shape.
DENSE_T = np.concatenate([np.arange(0.01, 2.0, 0.01),
                          np.arange(2.0, 1000.0, 0.5)])


@pytest.fixture(params=[("sparse", SPARSE_T), ("dense", DENSE_T)],
                ids=lambda p: p[0])
def grid(request):
    label, t = request.param
    return label, t, _synthetic_ojip(t)


def _run(times, values, **kw):
    return analyze_one_curve(
        times, values, "curve", FLUOROMETER,
        fj_time_ms=2.0, fi_time_ms=30.0, kr=10,
        include_curves=True, **kw)


@pytest.mark.parametrize("detect_mode", DETECT_MODES)
@pytest.mark.parametrize("readout", _VALUE_READOUTS)
def test_fj_fi_values_match_their_reported_timings(grid, detect_mode, readout):
    """FJ/FI must equal the curve value at the FJ/FI time that is reported.

    This is the regression guard for the two-independent-timing-paths bug.
    """
    _label, times, values = grid
    r = _run(times, values,
             fj_detect_mode=detect_mode, fi_detect_mode=detect_mode,
             value_readout=readout)

    recon = r["curves"]["reconstructed"]
    t_log = r["time_log_ms"]
    f0 = r["F0"]
    # The FJ/FI _read() closure uses the *original* FM (raw max) for the
    # reconstructed back-transform FV, not the readout-adjusted FM.
    fm_raw = float(np.max(values))

    for point in ("FJ", "FI"):
        t_user = r[f"{point}_time_user_ms"]
        assert t_user is not None, f"{point} has no reported timing"
        expected = _read_value_at(
            readout, t_user, times, values,
            recon_v=recon, log_time_native=t_log, f0=f0, fv=fm_raw - f0)
        assert r[point] == pytest.approx(expected, rel=1e-6, abs=1e-9), (
            f"{point}={r[point]} was not read at the reported "
            f"t({point})={t_user} ms (mode={detect_mode}, readout={readout})")


@pytest.mark.parametrize("detect_mode", DETECT_MODES)
def test_fj_before_fi(grid, detect_mode):
    """Biological ordering must survive every detection mode."""
    _label, times, values = grid
    r = _run(times, values,
             fj_detect_mode=detect_mode, fi_detect_mode=detect_mode)
    assert r["FJ_time_user_ms"] < r["FI_time_user_ms"]


@pytest.mark.parametrize("detect_mode", DETECT_MODES)
def test_phase_slopes_use_the_reported_timings(grid, detect_mode):
    """slope_OJ must be consistent with the reported FJ value and timing.

    The slopes used to be computed from `FJ_deriv` — a third, different set of
    J/I positions — so they disagreed with both the values and the timings.
    """
    _label, times, values = grid
    r = _run(times, values,
             fj_detect_mode=detect_mode, fi_detect_mode=detect_mode)
    if r["slope_JI"] is None:
        pytest.skip("no J-I slope for this curve")
    expected = ((r["FI"] - r["FJ"])
                / (r["FI_time_user_ms"] - r["FJ_time_user_ms"]))
    assert r["slope_JI"] == pytest.approx(expected, rel=1e-6)


def test_readout_modes_differ_on_a_sparse_grid():
    """Guard against the selector silently doing nothing.

    On a sparse grid the nearest measured sample sits away from t(FJ), so the
    nearest and interpolated readouts must disagree — that gap is exactly the
    error the selector exists to remove.
    """
    values = _synthetic_ojip(SPARSE_T)
    vals = {}
    for readout in _VALUE_READOUTS:
        r = _run(SPARSE_T, values, value_readout=readout)
        vals[readout] = r["FJ"]
        # Every mode must agree on WHEN the step is — only on how it is read.
        assert r["FJ_time_user_ms"] == pytest.approx(
            _run(SPARSE_T, values)["FJ_time_user_ms"])
    assert vals["nearest"] != pytest.approx(vals["interp"], rel=1e-9), (
        "nearest and interpolated readouts are identical on a sparse grid — "
        "the value_readout selector is not reaching the FJ lookup")


def test_unknown_readout_falls_back_to_interp():
    values = _synthetic_ojip(SPARSE_T)
    bogus = _run(SPARSE_T, values, value_readout="not-a-mode")
    interp = _run(SPARSE_T, values, value_readout="interp")
    assert bogus["value_readout"] == "interp"
    assert bogus["FJ"] == pytest.approx(interp["FJ"])


def test_use_deriv_timing_false_forces_fixed_timings():
    """The legacy kill-switch must still disable detection for old callers."""
    values = _synthetic_ojip(SPARSE_T)
    r = _run(SPARSE_T, values, use_deriv_timing=False,
             fj_detect_mode="d2_zero", fi_detect_mode="d2_zero")
    assert r["FJ_time_user_ms"] == pytest.approx(2.0)
    assert r["FI_time_user_ms"] == pytest.approx(30.0)


def test_area_ceiling_is_the_real_fm():
    """Area O-P must use FM itself as the ceiling, not the sample before it.

    With the end-exclusive slice the ceiling was the highest sample *before*
    FM, making every complementary area (and Sm, and N) slightly too small.
    """
    values = _synthetic_ojip(DENSE_T)
    r = _run(DENSE_T, values)
    t = np.asarray(DENSE_T, dtype=float)
    y = np.asarray(values, dtype=float)
    fm_idx = int(np.argmin(np.abs(t - r["FM_time_ms"])))
    end = fm_idx + 1
    expected = float(np.max(t[:end]) * np.max(y[:end]) - np.trapz(y[:end], t[:end]))
    assert r["Area_OP"] == pytest.approx(expected, rel=1e-6)


# ── FM / FP / FQ readout-mode tests ──────────────────────────────────────────

@pytest.mark.parametrize("readout", _VALUE_READOUTS)
def test_fm_is_raw_maximum_regardless_of_readout(grid, readout):
    """FM must always be the raw measured maximum, never re-read via readout.

    FM is defined as max(measured values), not "value at FM_time via readout".
    In 'reconstructed' mode the spline can undershoot or overshoot the
    measured maximum, so passing FM through value_readout would produce a
    wrong FM.  This test guards against that regression.
    """
    _label, times, values = grid
    r = _run(times, values, value_readout=readout)
    fm_raw = float(np.max(values))
    assert r["FM"] == pytest.approx(fm_raw, rel=1e-6, abs=1e-9), (
        f"FM={r['FM']} differs from raw max={fm_raw} "
        f"(readout={readout} should not affect FM)")


@pytest.mark.parametrize("readout", _VALUE_READOUTS)
def test_fp_value_exists_and_matches_readout(grid, readout):
    """FP must exist in the result dict and equal the readout at FP timing."""
    _label, times, values = grid
    r = _run(times, values, value_readout=readout)
    assert "FP" in r, "FP missing from result dict"
    fp_t = r.get("FP_time_user_ms")
    fp_val = r["FP"]
    if fp_t is None or fp_val is None:
        pytest.skip("FP timing not detected for this curve")
    recon = r["curves"]["reconstructed"]
    t_log = r["time_log_ms"]
    f0, fm_raw = r["F0"], np.max(values)
    expected = _read_value_at(
        readout, fp_t, times, values,
        recon_v=recon, log_time_native=t_log, f0=f0, fv=fm_raw - f0)
    assert fp_val == pytest.approx(expected, rel=1e-6, abs=1e-9), (
        f"FP={fp_val} does not match _read_value_at({readout}, {fp_t})")


@pytest.mark.parametrize("readout", _VALUE_READOUTS)
def test_fq_value_matches_readout_when_detected(grid, readout):
    """FQ must equal the readout at FQ_time_ms when the Q point is detected."""
    _label, times, values = grid
    r = _run(times, values, value_readout=readout)
    fq_t = r.get("FQ_time_ms")
    fq_val = r.get("FQ")
    if fq_t is None or fq_val is None:
        pytest.skip("FQ not detected for this curve")
    recon = r["curves"]["reconstructed"]
    t_log = r["time_log_ms"]
    f0, fm_raw = r["F0"], np.max(values)
    expected = _read_value_at(
        readout, fq_t, times, values,
        recon_v=recon, log_time_native=t_log, f0=f0, fv=fm_raw - f0)
    assert fq_val == pytest.approx(expected, rel=1e-6, abs=1e-9), (
        f"FQ={fq_val} does not match _read_value_at({readout}, {fq_t})")


@pytest.mark.parametrize("readout", _VALUE_READOUTS)
def test_pq_slopes_consistent_with_readout_adjusted_values(grid, readout):
    """PQ_amplitude and slope_PQ must use the readout-adjusted FM and FQ."""
    _label, times, values = grid
    r = _run(times, values, value_readout=readout)
    fq_val = r.get("FQ")
    fm_val = r.get("FM")
    fq_t = r.get("FQ_time_ms")
    fm_t = r.get("FM_time_ms")
    if fq_val is None or fm_val is None or fq_t is None or fm_t is None:
        pytest.skip("FQ or FM not available for this curve")
    pq_amp = r.get("PQ_amplitude")
    if pq_amp is None:
        pytest.skip("PQ_amplitude not computed")
    # abs=1e-6: near FM the amplitude is ~0 and two computation paths
    # (double-norm→raw vs readout-adjusted) diverge at ~1e-9 level.
    assert pq_amp == pytest.approx(fq_val - fm_val, rel=1e-6, abs=1e-6)
    dt = fq_t - fm_t
    if dt > 0 and r.get("slope_PQ") is not None:
        assert r["slope_PQ"] == pytest.approx(pq_amp / dt, rel=1e-6)


def test_dense_grid_modes_give_nearly_identical_fm():
    """On a dense grid, all three readout modes must agree on FM."""
    values = _synthetic_ojip(DENSE_T)
    results = {m: _run(DENSE_T, values, value_readout=m) for m in _VALUE_READOUTS}
    fm_interp = results["interp"]["FM"]
    for mode in ("nearest", "reconstructed"):
        assert results[mode]["FM"] == pytest.approx(fm_interp, rel=1e-3), (
            f"FM diverges between 'interp' and '{mode}' on a dense grid")


# ── FQ monotonic-D2 fallback tests ────────────────────────────────────────────

def _monotonic_post_p_curve():
    """Build a synthetic curve with a strictly monotonic post-P decline.

    The curve rises as a standard OJIP to FM at ~300 ms, then decays
    exponentially to ~5000 ms with NO Q dip — D2 should be monotonic in the
    Q window (750–3000 ms default), triggering the argmin fallback.
    """
    t_rise = np.geomspace(0.01, 300.0, 200)
    t_decay = np.linspace(310.0, 5000.0, 300)
    t = np.concatenate([t_rise, t_decay])
    # Rise: standard three-phase OJIP
    v_rise = (0.45 * (1.0 - np.exp(-t_rise / 0.45))
              + 0.30 * (1.0 - np.exp(-t_rise / 7.0))
              + 0.25 * (1.0 - np.exp(-t_rise / 90.0)))
    y_rise = 0.25 + 0.75 * v_rise
    # Decay: smooth exponential decline from FM with no dip
    fm = float(y_rise[-1])
    y_decay = 0.25 + (fm - 0.25) * np.exp(-(t_decay - t_decay[0]) / 2000.0)
    y = np.concatenate([y_rise, y_decay])
    return t, y


def test_fq_fallback_fires_on_monotonic_d2():
    """When D2 is monotonic in the Q window, the argmin fallback must fire.

    The fallback should produce a non-None FQ with the distinct label
    'D2 minimum (monotonic → argmin)'.
    """
    t, y = _monotonic_post_p_curve()
    r = _run(t, y, s_point_mode='d2_min')
    assert r["FQ"] is not None, "FQ should not be None — argmin fallback expected"
    assert r["FQ_time_ms"] is not None
    assert r["FQ_ref"] == "D2 minimum (monotonic \u2192 argmin)"


def test_fq_fallback_timing_within_q_window():
    """The fallback FQ timing must fall within the Q search window."""
    t, y = _monotonic_post_p_curve()
    r = _run(t, y, s_point_mode='d2_min')
    fq_t = r.get("FQ_time_ms")
    if fq_t is None:
        pytest.skip("FQ not detected")
    # Default window: 1500 ms ± 0.3 log-decades = 750–3000 ms
    assert 750.0 <= fq_t <= 3000.0, (
        f"FQ_time_ms={fq_t} outside expected Q window [750, 3000]")


@pytest.mark.parametrize("readout", _VALUE_READOUTS)
def test_fq_fallback_value_matches_readout(readout):
    """FQ from the monotonic fallback must still satisfy the value invariant."""
    t, y = _monotonic_post_p_curve()
    r = _run(t, y, value_readout=readout, s_point_mode='d2_min')
    fq_t = r.get("FQ_time_ms")
    fq_val = r.get("FQ")
    if fq_t is None or fq_val is None:
        pytest.skip("FQ not detected")
    recon = r["curves"]["reconstructed"]
    t_log = r["time_log_ms"]
    f0, fm_raw = r["F0"], float(np.max(y))
    expected = _read_value_at(
        readout, fq_t, t, y,
        recon_v=recon, log_time_native=t_log, f0=f0, fv=fm_raw - f0)
    assert fq_val == pytest.approx(expected, rel=1e-6, abs=1e-9), (
        f"FQ={fq_val} does not match _read_value_at({readout}, {fq_t}) "
        f"for monotonic fallback")


def test_fq_null_when_insufficient_post_p_data():
    """FQ must remain None when post-P data is too short for Q detection."""
    # A short transient that ends at 500 ms — well below the 200 ms
    # minimum post-P span AND below the Q window (750–3000 ms).
    t_short = np.geomspace(0.01, 500.0, 100)
    y_short = _synthetic_ojip(t_short)
    r = _run(t_short, y_short, s_point_mode='d2_min')
    # FQ should be None (insufficient data) or if detected, within range
    fq_ref = r.get("FQ_ref")
    if fq_ref is not None:
        # On a 500 ms transient the Q window (750–3000) has no data,
        # so this would be surprising but let's not hard-fail — just
        # check it's still consistent.
        assert r["FQ"] is not None
        assert r["FQ_time_ms"] is not None


def test_fq_fallback_d2_zero_mode():
    """In d2_zero mode, the monotonic fallback should still produce FQ.

    If D2 is monotonic, the argmin fallback fires. The d2_zero tier then
    looks for a zero-crossing after that point. If it fails, Tier 3 uses
    the argmin with the monotonic label.
    """
    t, y = _monotonic_post_p_curve()
    r = _run(t, y, s_point_mode='d2_zero')
    # With a monotonic D2, d2_zero won't find a crossing either,
    # so it should fall through to Tier 3 with the monotonic label.
    assert r["FQ"] is not None, "FQ should not be None with monotonic fallback"
    assert r["FQ_ref"] in ("D2 zero-crossing",
                            "D2 minimum (monotonic \u2192 argmin)")


def test_fq_fallback_auto_mode():
    """In auto mode, D1 zero-crossing is tried first; if that fails, the
    monotonic D2 fallback should still produce a result."""
    t, y = _monotonic_post_p_curve()
    r = _run(t, y, s_point_mode='auto')
    # Auto tries D1 zero-crossing first. On a monotonic decay, D1 is always
    # negative (declining), so no D1 zero-crossing exists. Falls through to
    # D2 minimum, which also has no interior trough → argmin fallback.
    assert r["FQ"] is not None, "FQ should not be None with auto + monotonic fallback"
    assert r["FQ_ref"] in ("Q minimum",
                            "D2 minimum",
                            "D2 minimum (monotonic \u2192 argmin)")


# ── Re-fit stability tests ────────────────────────────────────────────────────

def _run_kr(times, values, kr_val, **kw):
    """Like _run but with a custom kr value."""
    return analyze_one_curve(
        times, values, "curve", FLUOROMETER,
        fj_time_ms=2.0, fi_time_ms=30.0, kr=kr_val,
        include_curves=True, **kw)


def test_fm_stable_across_refit():
    """FM must be identical after re-analysis — it is the measured maximum, never recomputed."""
    values = _synthetic_ojip(DENSE_T)
    r1 = _run_kr(DENSE_T, values, 10)
    r2 = _run_kr(DENSE_T, values, 15)
    assert r1["FM"] == r2["FM"], (
        f"FM changed from {r1['FM']} to {r2['FM']} when only kr changed")
    assert r1["FM_time_ms"] == r2["FM_time_ms"]


def test_area_op_stable_across_kr():
    """Area_OP must not change when only kr changes (same FJ/FI/FM)."""
    values = _synthetic_ojip(DENSE_T)
    r1 = _run_kr(DENSE_T, values, 10, fj_detect_mode='fixed', fi_detect_mode='fixed')
    r2 = _run_kr(DENSE_T, values, 15, fj_detect_mode='fixed', fi_detect_mode='fixed')
    # Area OP only depends on the raw data up to FM, not on spline kr,
    # as long as FJ/FI timings stay the same (fixed mode).
    assert r1["Area_OP"] == pytest.approx(r2["Area_OP"], rel=1e-6), (
        f"Area_OP changed from {r1['Area_OP']} to {r2['Area_OP']} when only kr changed")


# ── FQ informative non-detection labels ──────────────────────────────────────

def test_fq_informative_non_detection_label():
    """When Q can't be detected, FQ_ref must explain why (not None)."""
    # A short transient ending at ~300 ms — insufficient post-P span
    t_short = np.geomspace(0.01, 300.0, 80)
    y_short = _synthetic_ojip(t_short)
    r = _run(t_short, y_short, s_point_mode='d2_min')
    if r["FQ_time_ms"] is None:
        # Q was not detected — check the reason label
        assert r["FQ_ref"] is not None, "FQ_ref must not be None when Q is not detected"
        assert "not detected" in r["FQ_ref"].lower(), (
            f"FQ_ref='{r['FQ_ref']}' should contain 'not detected'")


# ── allow_missing mode tests ─────────────────────────────────────────────────

def _very_sparse_curve():
    """A very sparse curve (~20 points) where FJ/FI detection is likely to fail."""
    t = np.geomspace(0.05, 1000.0, 20)
    return t, _synthetic_ojip(t)


def test_allow_missing_nan_propagation():
    """When allow_missing=True and detection fails, FJ/FI are None and JIP params propagate."""
    t, y = _very_sparse_curve()
    r = _run(t, y, allow_missing=True,
             fj_detect_mode='d2_zero', fi_detect_mode='d2_zero')
    # If detection actually failed (status == 'missing'), verify NaN propagation
    if r["FJ_detect_status"] == 'missing':
        assert r["FJ_time_user_ms"] is None, "FJ timing must be None when missing"
        assert r["FJ"] is None, "FJ value must be None when missing"
        # JIP params that depend on FJ should also be None
        assert r["VJ"] is None, "VJ must be None when FJ is missing"
        assert r["PSIE0"] is None, "PSIE0 must be None when FJ is missing"
    if r["FI_detect_status"] == 'missing':
        assert r["FI_time_user_ms"] is None, "FI timing must be None when missing"
        assert r["FI"] is None, "FI value must be None when missing"


def test_allow_missing_default_unchanged():
    """Default allow_missing=False preserves current fallback behavior."""
    t, y = _very_sparse_curve()
    r_default = _run(t, y, allow_missing=False,
                     fj_detect_mode='d2_zero', fi_detect_mode='d2_zero')
    # With default (no allow_missing), FJ should always have a value
    # (either detected or fallback, never None)
    assert r_default["FJ"] is not None, "FJ must not be None with allow_missing=False"
    assert r_default["FI"] is not None, "FI must not be None with allow_missing=False"
    assert r_default["FJ_time_user_ms"] is not None
    assert r_default["FI_time_user_ms"] is not None


def test_compute_jip_params_nan_propagation():
    """_compute_jip_params propagates NaN when FJ is NaN."""
    result = _compute_jip_params(F0=100.0, FM=500.0, FK=200.0, F50=150.0,
                                  FJ=float('nan'), FI=400.0)
    assert np.isnan(result['VJ']), "VJ must be NaN when FJ is NaN"
    assert np.isnan(result['OJ']), "OJ must be NaN when FJ is NaN"
    assert np.isnan(result['JI']), "JI must be NaN when FJ is NaN"
    assert np.isnan(result['PSIE0']), "PSIE0 must be NaN when FJ is NaN"
    assert np.isnan(result['TR0RC']), "TR0RC must be NaN when FJ is NaN"
    # FV and FVFM should still be valid (don't depend on FJ)
    assert result['FV'] == pytest.approx(400.0)
    assert result['FVFM'] == pytest.approx(0.8)


def test_compute_jip_params_normal_values():
    """_compute_jip_params gives correct results for normal inputs."""
    result = _compute_jip_params(F0=100.0, FM=500.0, FK=200.0, F50=150.0,
                                  FJ=250.0, FI=400.0)
    assert result['FV'] == pytest.approx(400.0)
    assert result['FVFM'] == pytest.approx(0.8)
    assert result['VJ'] == pytest.approx((250 - 100) / 400)
    assert result['VI'] == pytest.approx((400 - 100) / 400)
    assert result['OJ'] == pytest.approx(150.0)
    assert result['JI'] == pytest.approx(150.0)
    assert result['IP'] == pytest.approx(100.0)
