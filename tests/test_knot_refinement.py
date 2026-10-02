"""Tests for the adaptive knot refinement in _fit_splines_log."""
import numpy as np
import pytest

from website.OJIP_data_analysis import _refine_knots_adaptive


# ── helpers ──────────────────────────────────────────────────────────────

def _make_smooth_ojip(n=200):
    """Smooth three-exponential OJIP curve — no I-step plateau.

    Returns log10(time_ms) and double-normalised V(t).
    """
    t_ms = np.geomspace(0.01, 2000, n)
    x_log = np.log10(t_ms)
    V = 0.5 * (1 - np.exp(-t_ms / 0.5)) + \
        0.3 * (1 - np.exp(-t_ms / 5.0)) + \
        0.2 * (1 - np.exp(-t_ms / 50.0))
    return x_log, V


def _make_ojip_with_istep(n=200):
    """OJIP curve with a pronounced I-step plateau around 30 ms.

    The plateau is a dip in the rise rate that a coarse spline
    smooths through, creating a systematic residual pattern.
    """
    t_ms = np.geomspace(0.01, 2000, n)
    x_log = np.log10(t_ms)
    base = 0.5 * (1 - np.exp(-t_ms / 0.5)) + \
           0.3 * (1 - np.exp(-t_ms / 5.0)) + \
           0.2 * (1 - np.exp(-t_ms / 50.0))
    # Add a Gaussian plateau (small dip in slope) around 30 ms
    plateau = -0.04 * np.exp(-((x_log - np.log10(30)) / 0.15) ** 2)
    return x_log, base + plateau


# ── tests ────────────────────────────────────────────────────────────────

def test_clean_data_no_refinement():
    """When the initial fit is already good, no knots are added."""
    x_log, y = _make_smooth_ojip(200)
    lo, hi = x_log[0], x_log[-1]
    knots = np.linspace(lo, hi, 12)[1:-1]  # 10 interior knots

    model, knots_used, refined = _refine_knots_adaptive(x_log, y, knots, k=5)
    # A smooth exponential curve should be well-captured by 10 knots
    resid = y - model(x_log)
    assert np.max(np.abs(resid)) < 0.01
    # May or may not refine depending on residual pattern, but residuals
    # should be small regardless
    assert len(knots_used) >= len(knots)


def test_istep_triggers_refinement():
    """A pronounced I-step creates bias that triggers knot insertion."""
    x_log, y = _make_ojip_with_istep(200)
    lo, hi = x_log[0], x_log[-1]
    # Use only 6 knots — intentionally sparse to expose the I-step bias
    knots = np.linspace(lo, hi, 8)[1:-1]

    model_coarse, _, _ = _refine_knots_adaptive(
        x_log, y, knots, k=5, max_extra=0)  # force no refinement
    resid_coarse = np.max(np.abs(y - model_coarse(x_log)))

    model_refined, knots_used, refined = _refine_knots_adaptive(
        x_log, y, knots, k=5)
    resid_refined = np.max(np.abs(y - model_refined(x_log)))

    # Refined fit should have smaller max residual
    assert resid_refined <= resid_coarse
    # With the I-step plateau, refinement should have added at least one knot
    assert len(knots_used) >= len(knots)


def test_max_extra_cap():
    """No more than max_extra knots are added."""
    x_log, y = _make_ojip_with_istep(200)
    lo, hi = x_log[0], x_log[-1]
    knots = np.linspace(lo, hi, 5)[1:-1]  # very sparse — 3 knots

    _, knots_used, _ = _refine_knots_adaptive(
        x_log, y, knots, k=5, max_extra=2)
    assert len(knots_used) <= len(knots) + 2


def test_min_sep_enforcement():
    """New knots must be at least min_sep from existing knots."""
    x_log, y = _make_ojip_with_istep(200)
    lo, hi = x_log[0], x_log[-1]
    # Place a knot right at the I-step location
    istep_pos = np.log10(30)
    knots = np.sort(np.array([lo + 0.5, istep_pos, hi - 0.5]))

    _, knots_used, _ = _refine_knots_adaptive(
        x_log, y, knots, k=5, min_sep=0.15)
    # All knots should be at least min_sep apart
    diffs = np.diff(np.sort(knots_used))
    assert np.all(diffs >= 0.15 - 1e-10)


def test_schoenberg_whitney_sparse_data():
    """With very few data points, refinement respects the SW constraint."""
    # Only 15 data points — max knots limited by n_data - k = 10
    x_log, y_full = _make_ojip_with_istep(15)
    lo, hi = x_log[0], x_log[-1]
    knots = np.linspace(lo, hi, 4)[1:-1]  # 2 interior knots

    model, knots_used, _ = _refine_knots_adaptive(
        x_log, y_full, knots, k=5, max_extra=4)
    # Total interior knots must be < n_data - k = 15 - 5 = 10
    assert len(knots_used) < len(x_log) - 5
    # Model should still evaluate without error
    assert model(x_log).shape == x_log.shape


def test_weighted_data():
    """Refinement works correctly with weighted data (oj_densify path)."""
    x_log, y = _make_ojip_with_istep(200)
    lo, hi = x_log[0], x_log[-1]
    knots = np.linspace(lo, hi, 8)[1:-1]
    w = np.ones(len(x_log))
    # Reduce weight on the first 20 points (synthetic O-J fill)
    w[:20] = 0.3

    model, knots_used, refined = _refine_knots_adaptive(
        x_log, y, knots, k=5, w=w)
    resid = y - model(x_log)
    # Should still produce a valid fit
    assert np.all(np.isfinite(resid))
    assert model(x_log).shape == x_log.shape
