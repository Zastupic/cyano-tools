"""
Analysis-basis reporting for the multi-curve (batch) OJIP path.

Background: a user cross-checked the batch export of an AquaPen/FluorPen
multi-OJIP file in Excel (interpolate the ``OJIP_raw`` sheet at t(FJ), compare
with FJ) and 557/755 curves disagreed by up to 32 %. The timing was correct —
the ``OJIP_raw`` sheet held the values *as uploaded*, while F0/FJ/FI/FM are
computed after ``_bg_correct`` subtracts the 11 µs ``Bckg`` reading and drops
that point. Every reported value was offset by exactly ``Bckg``.

Fix: ``analyze_one_curve`` reports ``basis_drop`` / ``basis_offset``
(``_basis_correction``) and the browser rebuilds the analysis-basis transient
from them for plots and the curve sheets of the export. These tests pin:

  * ``_basis_correction`` recovers exactly what ``_bg_correct`` did, per mode;
  * on the real multi-OJIP fixture, interpolating the basis at the reported
    timing reproduces FJ/FI (the Excel cross-check) and FM/F0 match the
    instrument footer;
  * the basis rebuilt from the two scalars is identical to the backend's own
    ``curves.raw`` / ``shifted_F0`` / ``double_norm`` arrays, so the JS
    rebuild (``_basisValues`` + ``_getNormValues``) cannot drift from them;
  * instruments without background correction report a no-op basis.

Fixture: tests/fixtures/aquapen_example_multi_OJIP.txt (FluorPen wide export,
755 curves × 549 timepoints, with Bckg/Fo/Fj/Fi/Fm footer rows).
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SECRET_KEY", "test-secret-key-basis")

from website import create_app
from website.OJIP_data_analysis import _basis_correction, _bg_correct

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
MULTI_FILE = os.path.join(FIXTURES, "aquapen_example_multi_OJIP.txt")

DETECT_MODES = ("d2_zero", "poly_inflect", "d2_min", "fixed")
# A spread of curves incl. the two from the user report (#1, #2) and the
# low-Fv/Fm outlier (#29, Fv/Fm 0.518 in the footer).
SAMPLE_COLS = (0, 1, 28, 100, 250, 400, 600, 754)


# ── helpers ───────────────────────────────────────────────────────────────

def _parse_fluorpen_wide(path):
    """Minimal parser for the FluorPen multi-curve export (mirrors _parseText).

    Returns (time_us, values[n_time, n_curves], footer{row_name: [per-curve]}).
    """
    with open(path, encoding="utf-8", errors="replace") as fh:
        rows = [ln.rstrip("\r\n").split("\t") for ln in fh]
    time_us, data, footer = [], [], {}
    started = False
    for r in rows:
        if r and r[0] == "index":
            started = True
            continue
        if not started or not r or not r[0].strip():
            continue
        try:
            t = float(r[0])
        except ValueError:
            vals = []
            for x in r[1:]:
                try:
                    vals.append(float(x))
                except ValueError:
                    vals.append(np.nan)
            footer[r[0]] = vals
            continue
        time_us.append(t)
        data.append([float(x) for x in r[1:] if x.strip()])
    n_curves = len(data[0])
    footer = {k: v[:n_curves] for k, v in footer.items()}   # rows end with a trailing tab
    return np.asarray(time_us), np.asarray(data, dtype=float), footer


@pytest.fixture(scope="module")
def multi():
    t, v, foot = _parse_fluorpen_wide(MULTI_FILE)
    return {"t": t, "v": v, "foot": foot}


@pytest.fixture(scope="module")
def client():
    app = create_app(testing=True)
    app.config["WTF_CSRF_ENABLED"] = False
    return app.test_client()


def _batch(client, multi, cols, **opts):
    body = {
        "fluorometer": "Aquapen",
        "time_native": multi["t"].tolist(),
        "curves": [
            {"slot": i, "name": f"c{c + 1}",
             "values": multi["v"][:, c].tolist(),
             "bckg": multi["foot"]["Bckg"][c],
             "fo_footer": multi["foot"]["Fo"][c]}
            for i, c in enumerate(cols)
        ],
        "FJ_time": 2.0, "FI_time": 30.0, "knots_reduction_factor": 10,
        "include_curves": False,
    }
    body.update(opts)
    resp = client.post("/api/ojip_process_batch", json=body)
    assert resp.status_code == 200, resp.get_data(as_text=True)[:500]
    data = resp.get_json()
    assert data["status"] == "success"
    for r in data["results"]:
        assert "error" not in r, r
    return data["results"]


def _basis(values, r):
    """The JS _basisValues() rule, in numpy: drop leading points, subtract offset."""
    return np.asarray(values, dtype=float)[r["basis_drop"]:] - (r["basis_offset"] or 0.0)


# ── _basis_correction unit tests ─────────────────────────────────────────

class TestBasisCorrection:
    def test_identity(self):
        v = np.array([1.0, 2.0, 3.0])
        assert _basis_correction(v, v) == (0, 0.0)

    def test_drop_and_offset_recovered(self):
        v_in = np.array([10.0, 50.0, 70.0, 90.0])
        v_out = v_in[1:] - 10.0
        assert _basis_correction(v_in, v_out) == (1, 10.0)

    def test_nan_in_transient_ignored(self):
        v_in = np.array([5.0, 20.0, np.nan, 40.0])
        drop, off = _basis_correction(v_in, v_in[1:] - 5.0)
        assert drop == 1 and off == pytest.approx(5.0)

    def test_empty_output(self):
        assert _basis_correction([1.0, 2.0], []) == (2, 0.0)

    @pytest.mark.parametrize("mode,n,bckg,exp_drop,exp_off", [
        ("auto",     1, 100.0, 1, 100.0),   # instrument Bckg subtracted, 1 dropped
        ("auto",     1, None,  1, 0.0),     # no footer → drop only
        ("subtract", 2, None,  2, None),    # mean of first 2 subtracted
        ("drop",     3, None,  3, 0.0),
        ("keep",     1, 100.0, 0, 0.0),
    ])
    def test_round_trip_with_bg_correct(self, mode, n, bckg, exp_drop, exp_off):
        t = np.array([11.0, 21.0, 31.0, 41.0, 51.0, 61.0])
        v = np.array([100.0, 104.0, 300.0, 500.0, 650.0, 700.0])
        sf = pd.DataFrame({"t": t, "c": v.copy()})
        out, _ = _bg_correct(sf, "t", ["c"], mode, n, {"c": bckg} if bckg else None)
        drop, off = _basis_correction(v, out["c"].values)
        assert drop == exp_drop
        if exp_off is None:
            exp_off = v[:n].mean()
        assert off == pytest.approx(exp_off)
        np.testing.assert_allclose(v[drop:] - off, out["c"].values, atol=1e-9)


# ── fixture sanity ───────────────────────────────────────────────────────

class TestFixture:
    def test_shape(self, multi):
        assert multi["v"].shape == (549, 755)
        assert multi["t"][0] == 11 and multi["t"][-1] == 2000001

    def test_footer_bckg_is_first_point(self, multi):
        """The instrument's Bckg is exactly the 11 µs reading — the offset
        the Excel cross-check found."""
        np.testing.assert_array_equal(multi["foot"]["Bckg"], multi["v"][0, :])


# ── the user's Excel cross-check, on the real multi-OJIP file ────────────

class TestMultiOjipCrossCheck:
    @pytest.fixture(scope="class")
    def results(self, client, multi):
        return _batch(client, multi, SAMPLE_COLS)

    def test_basis_reports_bckg(self, results, multi):
        for r, c in zip(results, SAMPLE_COLS):
            assert r["basis_drop"] == 1
            assert r["basis_offset"] == pytest.approx(multi["foot"]["Bckg"][c])

    def test_fj_fi_match_basis_at_reported_timing(self, results, multi):
        """Interpolating the background-corrected curve at t(FJ)/t(FI)
        reproduces FJ/FI — i.e. what the exported OJIP_raw sheet now holds."""
        t_ms = multi["t"] * 1e-3
        for r, c in zip(results, SAMPLE_COLS):
            b = _basis(multi["v"][:, c], r)
            tb = t_ms[r["basis_drop"]:]
            assert r["FJ"] == pytest.approx(np.interp(r["FJ_time_user_ms"], tb, b), rel=1e-9)
            assert r["FI"] == pytest.approx(np.interp(r["FI_time_user_ms"], tb, b), rel=1e-9)

    def test_uncorrected_differs_by_exactly_bckg(self, results, multi):
        """Documents the original report: on the as-uploaded values the
        mismatch is exactly the instrument Bckg, not a timing error."""
        t_ms = multi["t"] * 1e-3
        for r, c in zip(results, SAMPLE_COLS):
            fj_raw = np.interp(r["FJ_time_user_ms"], t_ms, multi["v"][:, c])
            assert fj_raw - r["FJ"] == pytest.approx(multi["foot"]["Bckg"][c], rel=1e-9)

    def test_fm_and_f0_match_instrument_footer(self, results, multi):
        for r, c in zip(results, SAMPLE_COLS):
            assert r["FM"] == pytest.approx(multi["foot"]["Fm"][c])
            assert r["F0"] == pytest.approx(multi["foot"]["Fo"][c])
            assert r["FM"] == pytest.approx(_basis(multi["v"][:, c], r).max())

    def test_domain_ranges(self, results):
        for r in results:
            assert 0.3 < r["FVFM"] < 0.85
            assert 0 < r["VJ"] < r["VI"] <= 1.0

    @pytest.mark.parametrize("detect_mode", DETECT_MODES)
    def test_invariant_across_detect_modes(self, client, multi, detect_mode):
        cols = (0, 1, 28)
        res = _batch(client, multi, cols,
                     fj_detect_mode=detect_mode, fi_detect_mode=detect_mode)
        t_ms = multi["t"] * 1e-3
        for r, c in zip(res, cols):
            b = _basis(multi["v"][:, c], r)
            tb = t_ms[r["basis_drop"]:]
            assert r["FJ"] == pytest.approx(np.interp(r["FJ_time_user_ms"], tb, b), rel=1e-9)
            assert r["FI"] == pytest.approx(np.interp(r["FI_time_user_ms"], tb, b), rel=1e-9)


# ── JS rebuild == backend arrays (single source of truth) ────────────────

class TestRebuildMatchesBackendCurves:
    """The browser rebuilds raw / F−F0 / double-normalised curves from
    (basis_drop, basis_offset, F0, FM). They must equal what the backend
    itself returns with include_curves=True."""

    @pytest.mark.parametrize("bg_mode,bg_n", [
        ("auto", 1), ("subtract", 3), ("drop", 2), ("keep", 1)])
    def test_rebuild(self, client, multi, bg_mode, bg_n):
        c = 0
        r = _batch(client, multi, (c,), include_curves=True,
                   background_mode=bg_mode, background_n=bg_n)[0]
        b = _basis(multi["v"][:, c], r)
        np.testing.assert_allclose(b, r["curves"]["raw"], atol=1e-6)
        np.testing.assert_allclose(b - r["F0"], r["curves"]["shifted_F0"], atol=1e-6)
        np.testing.assert_allclose((b - r["F0"]) / (r["FM"] - r["F0"]),
                                   r["curves"]["double_norm"], atol=1e-9)
        np.testing.assert_allclose(multi["t"][r["basis_drop"]:] * 1e-3,
                                   r["time_raw_ms"], atol=1e-12)

    def test_mode_values(self, client, multi):
        v0 = multi["v"][:, 0]
        exp = {
            ("auto", 1):     (1, multi["foot"]["Bckg"][0]),
            ("subtract", 3): (3, v0[:3].mean()),
            ("drop", 2):     (2, 0.0),
            ("keep", 1):     (0, 0.0),
        }
        for (mode, n), (d, off) in exp.items():
            r = _batch(client, multi, (0,), background_mode=mode, background_n=n)[0]
            assert r["basis_drop"] == d, mode
            assert r["basis_offset"] == pytest.approx(off), mode

    def test_double_norm_peaks_at_one(self, client, multi):
        """Before the fix, the multi-curve plots normalised the *uncorrected*
        values with corrected F0/FM, peaking at 1 + Bckg/FV (≈ 1.10)."""
        r = _batch(client, multi, (0,))[0]
        b = _basis(multi["v"][:, 0], r)
        dn = (b - r["F0"]) / (r["FM"] - r["F0"])
        assert dn.max() == pytest.approx(1.0)
        wrong = (multi["v"][:, 0] - r["F0"]) / (r["FM"] - r["F0"])
        assert wrong.max() > 1.05


# ── instruments without background correction ────────────────────────────

class TestNoCorrectionInstruments:
    def test_handypea_basis_is_noop(self, client):
        with open(os.path.join(FIXTURES, "handypea_example.HAN"), "rb") as fh:
            import io
            resp = client.post("/api/ojip_parse_han",
                               data={"han_file": (io.BytesIO(fh.read()), "handypea_example.HAN")},
                               content_type="multipart/form-data")
        parsed = resp.get_json()
        assert parsed["status"] == "success"
        body = {
            "fluorometer": "HandyPEA", "time_native": parsed["time_native"],
            "curves": [{"slot": 0, "name": "h1", "values": parsed["curves"][0]["values"]}],
            "FJ_time": 2.0, "FI_time": 30.0, "knots_reduction_factor": 10,
        }
        r = client.post("/api/ojip_process_batch", json=body).get_json()["results"][0]
        assert "error" not in r, r
        assert r["basis_drop"] == 0 and r["basis_offset"] == 0.0

    def test_ojipimaging_basis_is_noop(self, client):
        t = np.geomspace(0.1, 2000, 120)
        y = 1 + 0.5 * (1 - np.exp(-t / 0.6)) + 0.3 * (1 - np.exp(-t / 10)) + 0.4 * (1 - np.exp(-t / 120))
        body = {
            "fluorometer": "OJIPImaging", "time_native": t.tolist(),
            "curves": [{"slot": 0, "name": "img1", "values": y.tolist()}],
            "FJ_time": 2.0, "FI_time": 30.0, "knots_reduction_factor": 10,
        }
        r = client.post("/api/ojip_process_batch", json=body).get_json()["results"][0]
        assert "error" not in r, r
        assert r["basis_drop"] == 0 and r["basis_offset"] == 0.0
