"""Tests for the O-J densify model functions and dispatcher."""
import numpy as np
import pytest

from website.OJIP_data_analysis import (
    _fit_oj_exponential,
    _fit_oj_biexponential,
    _fit_oj_connectivity,
    _oj_densify,
)


# ── helpers ──────────────────────────────────────────────────────────────

def _make_sparse_oj(model_fn, t_points_ms=None):
    """Create TOMI-3-like sparse O-J data with a gap from 0.1→0.5 ms."""
    if t_points_ms is None:
        t_points_ms = np.array([0.1, 0.5, 1.0, 2.0, 5.0, 10.0])
    x_log = np.log10(t_points_ms)
    y = model_fn(t_points_ms)
    return x_log, y


# ── exponential model ────────────────────────────────────────────────────

def test_exponential_basic():
    A_true, tau_true = 0.6, 1.5
    model_fn = lambda t: A_true * (1 - np.exp(-t / tau_true))
    t = np.array([0.1, 0.5, 1.0, 2.0, 5.0, 10.0])
    predict, info = _fit_oj_exponential(t, model_fn(t), {})
    assert info['model'] == 'exponential'
    assert abs(info['tau_ms'] - tau_true) < 0.2
    assert abs(info['A'] - A_true) < 0.1
    # predict should reproduce the data
    assert np.allclose(predict(t), model_fn(t), atol=0.02)


def test_exponential_fixed_tau():
    A_true, tau_true = 0.6, 1.5
    model_fn = lambda t: A_true * (1 - np.exp(-t / tau_true))
    t = np.array([0.1, 0.5, 1.0, 2.0, 5.0, 10.0])
    predict, info = _fit_oj_exponential(t, model_fn(t), {'tau_ms': tau_true})
    assert info['tau_ms'] == tau_true
    assert abs(info['A'] - A_true) < 0.05


# ── biexponential model ─────────────────────────────────────────────────

def test_biexponential_basic():
    A1, tau1, A2, tau2 = 0.3, 0.3, 0.3, 2.0
    model_fn = lambda t: A1 * (1 - np.exp(-t / tau1)) + A2 * (1 - np.exp(-t / tau2))
    t = np.array([0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0])
    predict, info = _fit_oj_biexponential(t, model_fn(t), {})
    assert info['model'] == 'biexponential'
    assert info['tau1_ms'] < info['tau2_ms']  # canonical order
    # Total amplitude at large t should match A1+A2
    assert abs(predict(100.0) - (A1 + A2)) < 0.05


def test_biexponential_fixed_taus():
    A1, tau1, A2, tau2 = 0.3, 0.3, 0.3, 2.0
    model_fn = lambda t: A1 * (1 - np.exp(-t / tau1)) + A2 * (1 - np.exp(-t / tau2))
    t = np.array([0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0])
    predict, info = _fit_oj_biexponential(t, model_fn(t), {'tau1_ms': tau1, 'tau2_ms': tau2})
    assert abs(info['A1'] - A1) < 0.05
    assert abs(info['A2'] - A2) < 0.05


# ── connectivity model ───────────────────────────────────────────────────

def _connectivity_model(t, A, k_L, p, k_ox=0.0):
    C = 1.0 - np.exp(-k_L * t)
    C_eff = C * np.exp(-k_ox * t)
    denom = 1.0 - p * C_eff
    denom = np.where(np.abs(denom) < 1e-12, 1e-12, denom)
    return A * C_eff * (1.0 - p) / denom


def test_connectivity_basic():
    A_true, kL_true, p_true = 0.6, 3.0, 0.4
    model_fn = lambda t: _connectivity_model(t, A_true, kL_true, p_true)
    t = np.array([0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0])
    predict, info = _fit_oj_connectivity(t, model_fn(t), {})
    assert info['model'] == 'connectivity'
    assert abs(info['p'] - p_true) < 0.15
    assert abs(info['k_L'] - kL_true) < 1.0
    assert info['k_ox'] == 0.0  # default fixed at 0


def test_connectivity_p_zero_matches_exponential():
    """With p=0, k_ox=0 the connectivity model degenerates to a simple exponential."""
    A_true, kL_true = 0.6, 2.0
    tau_equiv = 1.0 / kL_true  # tau = 1/k_L for the exponential case
    exp_fn = lambda t: A_true * (1 - np.exp(-t / tau_equiv))
    conn_fn = lambda t: _connectivity_model(t, A_true, kL_true, 0.0, 0.0)
    t = np.array([0.1, 0.5, 1.0, 2.0, 5.0])
    np.testing.assert_allclose(exp_fn(t), conn_fn(t), atol=1e-10)


def test_connectivity_with_kox():
    """User-specified k_ox > 0 should be honoured."""
    A_true, kL_true, p_true, kox_true = 0.6, 3.0, 0.4, 0.3
    model_fn = lambda t: _connectivity_model(t, A_true, kL_true, p_true, kox_true)
    t = np.array([0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0])
    predict, info = _fit_oj_connectivity(t, model_fn(t), {'k_ox': kox_true})
    assert info['k_ox'] == kox_true
    assert abs(info['p'] - p_true) < 0.15


# ── dispatcher (_oj_densify) ─────────────────────────────────────────────

def test_densify_no_gap():
    """Dense data with no gaps → no-op."""
    t_ms = np.logspace(-1, 1, 50)  # 0.1 to 10 ms, dense
    x_log = np.log10(t_ms)
    y = 0.6 * (1 - np.exp(-t_ms / 1.5))
    fj_hi_log = np.log10(10.0)
    x_out, y_out, w_out, info = _oj_densify(x_log, y, fj_hi_log)
    assert info is None
    assert len(x_out) == len(x_log)
    np.testing.assert_array_equal(w_out, np.ones(len(x_log)))


def test_densify_exponential_fills_gap():
    """Sparse data with a gap → synthetic points inserted."""
    A_true, tau_true = 0.6, 1.5
    t_ms = np.array([0.1, 0.5, 1.0, 2.0, 5.0, 10.0])
    x_log = np.log10(t_ms)
    y = A_true * (1 - np.exp(-t_ms / tau_true))
    fj_hi_log = np.log10(10.0)
    x_out, y_out, w_out, info = _oj_densify(x_log, y, fj_hi_log, model='exponential')
    assert info is not None
    assert info['model'] == 'exponential'
    assert len(x_out) > len(x_log)  # synthetic points added
    # Weights: real=1.0, synthetic=0.3
    assert np.all(w_out[(w_out < 1.0)] == pytest.approx(0.3))


def test_densify_connectivity_model():
    """Connectivity model produces valid output through the dispatcher."""
    A_true, kL_true, p_true = 0.6, 3.0, 0.4
    t_ms = np.array([0.1, 0.5, 1.0, 2.0, 5.0, 10.0])
    x_log = np.log10(t_ms)
    y = _connectivity_model(t_ms, A_true, kL_true, p_true)
    fj_hi_log = np.log10(10.0)
    x_out, y_out, w_out, info = _oj_densify(
        x_log, y, fj_hi_log, model='connectivity')
    assert info is not None
    assert info['model'] == 'connectivity'
    assert len(x_out) > len(x_log)


def test_densify_fallback_on_bad_data():
    """Garbage data → graceful return with info=None."""
    x_log = np.array([-1.0, -0.3, 0.0, 0.3, 0.7, 1.0])
    y = np.zeros(6)  # all zeros — impossible to fit
    fj_hi_log = np.log10(10.0)
    x_out, y_out, w_out, info = _oj_densify(x_log, y, fj_hi_log, model='connectivity')
    # Should either fall back to exponential or return None
    assert len(x_out) >= len(x_log)


def test_densify_unknown_model_defaults_to_exponential():
    """Unknown model string → defaults to exponential."""
    t_ms = np.array([0.1, 0.5, 1.0, 2.0, 5.0, 10.0])
    x_log = np.log10(t_ms)
    y = 0.6 * (1 - np.exp(-t_ms / 1.5))
    fj_hi_log = np.log10(10.0)
    x_out, y_out, w_out, info = _oj_densify(
        x_log, y, fj_hi_log, model='nonexistent')
    assert info is not None
    assert info['model'] == 'exponential'
