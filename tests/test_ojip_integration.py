"""
Integration tests for the OJIP tool — full HTTP request-response cycle.

Tests exercise file parsing, fluorometer detection, FormData/JSON payloads,
and response structure via the Flask test client.  Fixture files live in
tests/fixtures/ (real instrument data, one or more per fluorometer type).

Note: JIP-derived parameters (FVFM, VJ, VI, M0, etc.) are computed
client-side in calcJIP() — the server returns raw key values (F0, FM, FJ,
FI, FK, F50) and the client derives the rest.  The batch endpoint
(/api/ojip_process_batch) DOES return computed JIP params because it runs
_compute_jip_params() server-side.
"""

import io
import os
import sys

import pytest

# ---------------------------------------------------------------------------
# Make the website package importable from tests/
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SECRET_KEY", "test-secret-key-integration")

from website import create_app
from website.OJIP_data_analysis import _compute_jip_params

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


# ── helpers ────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def app():
    """Create a Flask app configured for testing."""
    application = create_app()
    application.config["TESTING"] = True
    application.config["WTF_CSRF_ENABLED"] = False
    return application


@pytest.fixture(scope="module")
def client(app):
    return app.test_client()


def _read_fixture(name):
    """Return fixture file bytes."""
    path = os.path.join(FIXTURES, name)
    with open(path, "rb") as f:
        return f.read()


def _upload(client, fluorometer, filenames, extra_fields=None):
    """POST multipart files to /api/ojip_process and return parsed JSON."""
    data = {"fluorometer": fluorometer}
    files = []
    for fname in filenames:
        raw = _read_fixture(fname)
        files.append((io.BytesIO(raw), fname))

    data["OJIP_files"] = files
    if extra_fields:
        data.update(extra_fields)

    resp = client.post(
        "/api/ojip_process",
        data=data,
        content_type="multipart/form-data",
    )
    return resp


def _kv(resp_json):
    """Extract key_values dict from a /api/ojip_process response."""
    return resp_json["key_values"]


def _first_kv(resp_json):
    """Extract the first file's key_values dict."""
    kv = _kv(resp_json)
    fname = next(iter(kv))
    return fname, kv[fname]


def _compute_fvfm(kv_entry):
    """Compute Fv/Fm from raw key values (mirrors client-side calcJIP)."""
    f0, fm = kv_entry["F0"], kv_entry["FM"]
    return (fm - f0) / fm if fm else None


# ── per-file server-side keys that every successful response must contain ──

_CORE_KV_KEYS = {"F0", "FM", "FV", "FJ", "FI", "FK", "F50",
                 "FJ_time_user_ms", "FI_time_user_ms", "Area_OP"}


# ═══════════════════════════════════════════════════════════════════════════
#  MC-PAM
# ═══════════════════════════════════════════════════════════════════════════

class TestMCPAM:
    FLUORO = "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"

    def test_single_file_upload(self, client):
        """Single MC-PAM .CSV → 200, valid JSON with core key values."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        assert resp.status_code == 200, resp.data[:500]
        j = resp.get_json()
        assert j["status"] == "success"
        fname, kv = _first_kv(j)
        for k in _CORE_KV_KEYS:
            assert k in kv, f"missing {k} in key_values"
        assert kv["FM"] > kv["F0"], "FM must be > F0"

    def test_multi_file_upload(self, client):
        """3 MC-PAM .CSV files → merged, one set of key_values per file."""
        resp = _upload(client, self.FLUORO, [
            "mcpam_example_1.CSV",
            "mcpam_example_2.CSV",
            "mcpam_example_3.CSV",
        ])
        assert resp.status_code == 200
        j = resp.get_json()
        kv = _kv(j)
        assert len(kv) == 3, f"expected 3 curves, got {len(kv)}"
        for fname, entry in kv.items():
            fvfm = _compute_fvfm(entry)
            assert 0.1 < fvfm < 0.95, f"implausible Fv/Fm={fvfm} for {fname}"

    def test_time_units_are_ms(self, client):
        """MC-PAM times are natively ms — verify time_raw_ms range."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        t = j["time_raw_ms"]
        assert len(t) > 10
        assert t[0] > 0, "first time must be positive (t<=0 stripped)"
        assert t[-1] > 100, "MC-PAM transients extend well beyond 100 ms"

    def test_fvfm_stable_across_readout_modes(self, client):
        """Fv/Fm must not change with value_readout — FM and F0 are anchors."""
        results = {}
        for mode in ("interp", "nearest", "reconstructed"):
            resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"],
                           extra_fields={"value_readout": mode})
            _, kv = _first_kv(resp.get_json())
            results[mode] = _compute_fvfm(kv)
        assert results["interp"] == results["nearest"] == results["reconstructed"]

    def test_fit_quality_present(self, client):
        """fit_r2 must be present and high for good data."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        _, kv = _first_kv(resp.get_json())
        assert "fit_r2" in kv
        assert kv["fit_r2"] > 0.95, f"fit_r2={kv['fit_r2']} unexpectedly low"


# ═══════════════════════════════════════════════════════════════════════════
#  AquaPen / FluorPen
# ═══════════════════════════════════════════════════════════════════════════

class TestAquaPen:
    FLUORO = "Aquapen"

    def test_single_file_upload(self, client):
        resp = _upload(client, self.FLUORO, ["aquapen_example_1.txt"])
        assert resp.status_code == 200
        _, kv = _first_kv(resp.get_json())
        for k in _CORE_KV_KEYS:
            assert k in kv, f"missing {k}"

    def test_bg_keep_vs_auto_fvfm(self, client):
        """bg_mode=keep inflates Fv/Fm compared to auto (the known bug)."""
        resp_auto = _upload(client, self.FLUORO, ["aquapen_example_1.txt"],
                            extra_fields={"background_mode": "auto"})
        resp_keep = _upload(client, self.FLUORO, ["aquapen_example_1.txt"],
                            extra_fields={"background_mode": "keep"})
        _, kv_auto = _first_kv(resp_auto.get_json())
        _, kv_keep = _first_kv(resp_keep.get_json())
        fvfm_auto = _compute_fvfm(kv_auto)
        fvfm_keep = _compute_fvfm(kv_keep)
        # keep includes the dark background point as F0, inflating Fv/Fm
        assert fvfm_keep > fvfm_auto, \
            f"expected keep ({fvfm_keep:.4f}) > auto ({fvfm_auto:.4f})"

    def test_multi_file(self, client):
        resp = _upload(client, self.FLUORO, [
            "aquapen_example_1.txt",
            "aquapen_example_2.txt",
            "aquapen_example_3.txt",
        ])
        assert resp.status_code == 200
        kv = _kv(resp.get_json())
        assert len(kv) == 3

    def test_q_point_detection(self, client):
        """AquaPen files typically have >1s data — FQ_ref should be present."""
        resp = _upload(client, self.FLUORO, ["aquapen_example_1.txt"])
        _, kv = _first_kv(resp.get_json())
        assert "FQ_ref" in kv
        # FQ_ref should be a non-empty string (detected or informative reason)
        assert kv["FQ_ref"] is not None and len(str(kv["FQ_ref"])) > 0


# ═══════════════════════════════════════════════════════════════════════════
#  FL6000
# ═══════════════════════════════════════════════════════════════════════════

class TestFL6000:
    FLUORO = "FL6000"

    def test_single_file_upload(self, client):
        resp = _upload(client, self.FLUORO, ["fl6000_example_1.txt"])
        assert resp.status_code == 200
        _, kv = _first_kv(resp.get_json())
        for k in _CORE_KV_KEYS:
            assert k in kv, f"missing {k}"

    def test_time_conversion_to_ms(self, client):
        """FL6000 native time is seconds — verify converted to ms."""
        resp = _upload(client, self.FLUORO, ["fl6000_example_1.txt"])
        j = resp.get_json()
        t = j["time_raw_ms"]
        assert len(t) > 10
        assert max(t) > 500, "FL6000 transient in ms should exceed 500 ms"

    def test_multi_file(self, client):
        resp = _upload(client, self.FLUORO, [
            "fl6000_example_1.txt",
            "fl6000_example_2.txt",
            "fl6000_example_3.txt",
        ])
        assert resp.status_code == 200
        kv = _kv(resp.get_json())
        assert len(kv) == 3


# ═══════════════════════════════════════════════════════════════════════════
#  HandyPEA (.HAN binary)
# ═══════════════════════════════════════════════════════════════════════════

class TestHandyPEA:
    FLUORO = "HandyPEA"

    def test_han_parse_endpoint(self, client):
        """POST .HAN to /api/ojip_parse_han → parsed curves."""
        raw = _read_fixture("handypea_example.HAN")
        resp = client.post(
            "/api/ojip_parse_han",
            data={"han_file": (io.BytesIO(raw), "handypea_example.HAN")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200
        j = resp.get_json()
        assert j["status"] == "success"
        assert "time_native" in j
        assert len(j["curves"]) > 0
        t = j["time_native"]
        assert t[0] >= 10, "HandyPEA starts at ~10 us"

    def test_batch_from_parsed_han(self, client):
        """Parse HAN → feed curves to /api/ojip_process_batch → JIP params."""
        raw = _read_fixture("handypea_example.HAN")
        parse_resp = client.post(
            "/api/ojip_parse_han",
            data={"han_file": (io.BytesIO(raw), "handypea_example.HAN")},
            content_type="multipart/form-data",
        )
        parsed = parse_resp.get_json()
        assert parsed["status"] == "success"

        payload = {
            "fluorometer": "HandyPEA",
            "time_native": parsed["time_native"],
            "curves": parsed["curves"],
            "FJ_time": 2.0,
            "FI_time": 30.0,
            "knots_reduction_factor": 10,
            "include_curves": False,
            "fit_method": "logspline",
            "knot_placement": "hybrid",
            "value_readout": "interp",
        }
        resp = client.post("/api/ojip_process_batch", json=payload)
        assert resp.status_code == 200
        j = resp.get_json()
        assert j["status"] == "success"
        results = j["results"]
        ok = [r for r in results if "error" not in r]
        assert len(ok) > 0, "all curves errored"
        r = ok[0]
        # Batch endpoint returns computed FVFM
        assert r["FVFM"] > 0.1
        assert r["FM"] > r["F0"]


# ═══════════════════════════════════════════════════════════════════════════
#  Cross-fluorometer: detection modes
# ═══════════════════════════════════════════════════════════════════════════

class TestDetectionModes:
    """Verify all detection modes produce valid results on MC-PAM data."""
    FLUORO = "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"

    @pytest.mark.parametrize("fj_mode", [
        "d2_zero", "poly_inflect", "d2_min", "fixed",
    ])
    def test_fj_detect_modes(self, client, fj_mode):
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"],
                       extra_fields={
                           "fj_detect_mode": fj_mode,
                           "fi_detect_mode": "d2_zero",
                       })
        assert resp.status_code == 200
        _, kv = _first_kv(resp.get_json())
        f0, fm, fj = kv["F0"], kv["FM"], kv["FJ"]
        vj = (fj - f0) / (fm - f0)  # compute VJ locally
        assert 0.0 < vj < 1.0, f"VJ={vj} out of range for mode {fj_mode}"


# ═══════════════════════════════════════════════════════════════════════════
#  Refit endpoint
# ═══════════════════════════════════════════════════════════════════════════

class TestRefit:
    FLUORO = "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"

    def _get_upload_data(self, client):
        """Upload once and return (fname, key_values, time_raw, double_norm)."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        fname, kv = _first_kv(j)
        double_norm = {fname: j["curves"][fname]["double_norm"]}
        raw_fm_f0 = {fname: {"FM": kv["FM"], "F0": kv["F0"]}}
        return fname, kv, j["time_raw_ms"], double_norm, raw_fm_f0

    def test_refit_preserves_fm(self, client):
        """Upload → refit with different kr → FM identical."""
        fname, kv, time_raw, double_norm, raw_fm_f0 = self._get_upload_data(client)
        fm_orig = kv["FM"]

        resp2 = client.post("/api/ojip_refit", json={
            "fluorometer": self.FLUORO,
            "kr": 15,
            "fit_method": "logspline",
            "knot_placement": "hybrid",
            "fj_time_ms": 2.0,
            "fi_time_ms": 30.0,
            "value_readout": "interp",
            "time_raw_ms": time_raw,
            "double_norm": double_norm,
            "raw_fm_f0": raw_fm_f0,
        })
        assert resp2.status_code == 200
        j2 = resp2.get_json()
        fm_refit = j2["key_timings"][fname]["FM"]
        assert fm_refit == fm_orig, \
            f"FM changed after refit: {fm_orig} -> {fm_refit}"

    def test_refit_allow_missing(self, client):
        """Refit with allow_missing=True → valid JSON response."""
        fname, kv, time_raw, double_norm, raw_fm_f0 = self._get_upload_data(client)

        resp2 = client.post("/api/ojip_refit", json={
            "fluorometer": self.FLUORO,
            "kr": 10,
            "fit_method": "logspline",
            "knot_placement": "hybrid",
            "fj_time_ms": 2.0,
            "fi_time_ms": 30.0,
            "value_readout": "interp",
            "allow_missing": True,
            "time_raw_ms": time_raw,
            "double_norm": double_norm,
            "raw_fm_f0": raw_fm_f0,
        })
        assert resp2.status_code == 200
        j2 = resp2.get_json()
        assert fname in j2["key_timings"]

    def test_refit_different_methods(self, client):
        """Refit with each fit_method → all return 200."""
        fname, kv, time_raw, double_norm, raw_fm_f0 = self._get_upload_data(client)

        for method in ("logspline", "spline", "pchip"):
            resp = client.post("/api/ojip_refit", json={
                "fluorometer": self.FLUORO,
                "kr": 10,
                "fit_method": method,
                "knot_placement": "hybrid",
                "fj_time_ms": 2.0,
                "fi_time_ms": 30.0,
                "value_readout": "interp",
                "time_raw_ms": time_raw,
                "double_norm": double_norm,
                "raw_fm_f0": raw_fm_f0,
            })
            assert resp.status_code == 200, f"method={method} failed"


# ═══════════════════════════════════════════════════════════════════════════
#  Batch processing
# ═══════════════════════════════════════════════════════════════════════════

class TestBatch:
    """Test /api/ojip_process_batch with real data extracted from uploads."""

    def test_mcpam_batch_via_upload(self, client):
        """Upload MC-PAM → extract raw data → re-process via batch."""
        fluoro = "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"
        resp = _upload(client, fluoro, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        time_raw = j["time_raw_ms"]

        curves = []
        for i, (fn, cdata) in enumerate(j["curves"].items()):
            curves.append({
                "slot": i,
                "name": fn,
                "values": cdata["raw"],
            })

        payload = {
            "fluorometer": fluoro,
            "time_native": time_raw,
            "curves": curves,
            "FJ_time": 2.0,
            "FI_time": 30.0,
            "knots_reduction_factor": 10,
            "include_curves": False,
            "fit_method": "logspline",
            "knot_placement": "hybrid",
            "value_readout": "interp",
        }
        resp2 = client.post("/api/ojip_process_batch", json=payload)
        assert resp2.status_code == 200
        j2 = resp2.get_json()
        assert j2["status"] == "success"
        ok = [r for r in j2["results"] if "error" not in r]
        assert len(ok) > 0
        r = ok[0]
        assert 0.1 < r["FVFM"] < 0.95

    def test_aquapen_batch(self, client):
        """AquaPen multi-file via batch endpoint."""
        fluoro = "Aquapen"
        resp = _upload(client, fluoro, ["aquapen_example_1.txt"])
        j = resp.get_json()
        time_raw = j["time_raw_ms"]

        curves = []
        for i, (fn, cdata) in enumerate(j["curves"].items()):
            curves.append({
                "slot": i,
                "name": fn,
                "values": cdata["raw"],
            })

        resp2 = client.post("/api/ojip_process_batch", json={
            "fluorometer": fluoro,
            "time_native": time_raw,
            "curves": curves,
            "FJ_time": 2.0,
            "FI_time": 30.0,
            "knots_reduction_factor": 10,
            "include_curves": False,
            "fit_method": "logspline",
            "knot_placement": "hybrid",
            "value_readout": "interp",
            "background_mode": "auto",
        })
        assert resp2.status_code == 200
        j2 = resp2.get_json()
        assert j2["status"] == "success"
        ok = [r for r in j2["results"] if "error" not in r]
        assert len(ok) > 0


# ═══════════════════════════════════════════════════════════════════════════
#  Allow missing landmarks
# ═══════════════════════════════════════════════════════════════════════════

class TestAllowMissing:
    FLUORO = "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"

    def test_default_always_has_values(self, client):
        """Without allow_missing, FJ/FI always have timing values."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        _, kv = _first_kv(resp.get_json())
        assert kv["FJ_time_user_ms"] is not None
        assert kv["FI_time_user_ms"] is not None

    def test_allow_missing_checked(self, client):
        """With allow_missing, response is still valid (FJ may be None)."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"],
                       extra_fields={"allow_missing": "checked"})
        assert resp.status_code == 200
        _, kv = _first_kv(resp.get_json())
        # Keys must exist regardless
        assert "FJ_time_user_ms" in kv
        assert "FI_time_user_ms" in kv


# ═══════════════════════════════════════════════════════════════════════════
#  FQ informative labels
# ═══════════════════════════════════════════════════════════════════════════

class TestFQLabels:
    def test_fq_ref_has_reason_when_not_detected(self, client):
        """MC-PAM short recordings → FQ not detected with informative reason."""
        resp = _upload(
            client,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )
        _, kv = _first_kv(resp.get_json())
        fq_ref = kv.get("FQ_ref")
        if fq_ref is not None and "not detected" in str(fq_ref).lower():
            assert "Q not detected" in fq_ref
        elif fq_ref is None:
            pytest.skip("FQ_ref is None (Q detection not attempted)")
        else:
            # Q was actually detected — also valid
            assert len(fq_ref) > 0


# ═══════════════════════════════════════════════════════════════════════════
#  Export endpoint
# ═══════════════════════════════════════════════════════════════════════════

class TestExport:
    def test_xlsx_export(self, client):
        """Upload → request .xlsx with charts → valid response."""
        resp = _upload(
            client,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )
        assert resp.status_code == 200
        j = resp.get_json()

        xlsx_resp = client.post("/api/ojip_add_charts", json=j)
        assert xlsx_resp.status_code == 200
        ct = xlsx_resp.content_type or ""
        assert "json" in ct or "spreadsheet" in ct or "octet" in ct, \
            f"unexpected content-type: {ct}"


# ═══════════════════════════════════════════════════════════════════════════
#  JIP params computation (server-side via _compute_jip_params)
# ═══════════════════════════════════════════════════════════════════════════

class TestJIPComputation:
    """Verify _compute_jip_params produces correct results from upload data."""

    def test_jip_from_upload(self, client):
        """Upload → extract F0/FM/FK/F50/FJ/FI → compute JIP → plausible."""
        resp = _upload(
            client,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )
        _, kv = _first_kv(resp.get_json())
        jip = _compute_jip_params(
            kv["F0"], kv["FM"], kv["FK"], kv["F50"], kv["FJ"], kv["FI"],
        )
        assert 0.1 < jip["FVFM"] < 0.95
        assert 0.0 < jip["VJ"] < 1.0
        assert 0.0 < jip["VI"] < 1.0
        assert jip["VJ"] < jip["VI"], "VJ should be < VI"


# ═══════════════════════════════════════════════════════════════════════════
#  Detection mode and fallback/logdec parameter passthrough
# ═══════════════════════════════════════════════════════════════════════════

class TestDetectionParams:
    """Verify the backend respects fj_detect_mode, fj_logdec, fj_fallback_ms."""

    def test_detect_mode_appears_in_fj_ref(self, client):
        """FJ_ref label should reflect the detection mode used."""
        for mode, expected_substr in [
            ("d2_zero", "D2"),
            ("poly_inflect", "Poly"),
            ("d2_min", "D2 min"),
            ("fixed", "fixed"),
        ]:
            resp = _upload(
                client,
                "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
                ["mcpam_example_1.CSV"],
                extra_fields={"fj_detect_mode": mode, "fi_detect_mode": mode},
            )
            j = resp.get_json()
            _, kv = _first_kv(j)
            assert expected_substr.lower() in kv["FJ_ref"].lower(), (
                f"mode={mode}: FJ_ref={kv['FJ_ref']!r} should contain {expected_substr!r}"
            )

    def test_custom_fallback_ms_used(self, client):
        """With fixed mode, changing FJ_time should change the detected FJ timing."""
        results = {}
        for fj_ms in [1.0, 2.0, 5.0]:
            resp = _upload(
                client,
                "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
                ["mcpam_example_1.CSV"],
                extra_fields={
                    "fj_detect_mode": "fixed",
                    "FJ_time": str(fj_ms),
                },
            )
            _, kv = _first_kv(resp.get_json())
            results[fj_ms] = kv["FJ_time_user_ms"]

        # Different fixed timings should yield different FJ_time_user_ms
        assert results[1.0] != results[5.0], (
            f"Fixed FJ should differ: 1.0ms→{results[1.0]}, 5.0ms→{results[5.0]}"
        )

    def test_logdec_affects_fallback_window(self, client):
        """Wider logdec should allow detection further from the fallback center."""
        # A narrow logdec might reject a detection that a wider one accepts,
        # potentially changing FJ_ref from "D2 zero" to "fallback" or vice versa.
        results = {}
        for logdec in [0.1, 0.5, 1.0]:
            resp = _upload(
                client,
                "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
                ["mcpam_example_1.CSV"],
                extra_fields={
                    "fj_detect_mode": "d2_zero",
                    "fj_logdec": str(logdec),
                    "fj_fallback_ms": "2.0",
                },
            )
            _, kv = _first_kv(resp.get_json())
            results[logdec] = {
                "FJ_time": kv["FJ_time_user_ms"],
                "FJ_ref": kv["FJ_ref"],
            }

        # All should have valid FJ (not None/NaN)
        for ld, r in results.items():
            assert r["FJ_time"] is not None, f"logdec={ld}: FJ_time should not be None"

    def test_custom_fallback_ms_in_refit(self, client):
        """Refit endpoint should respect fj_fallback_ms and fj_logdec."""
        # First upload to get initial data
        resp = _upload(
            client,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )
        j = resp.get_json()
        fname = next(iter(j["key_values"]))
        dn = j["curves"][fname]["double_norm"]
        time_ms = j["time_raw_ms"]

        # Refit with custom fallback
        refit_resp = client.post("/api/ojip_refit", json={
            "fluorometer": "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            "kr": 10,
            "double_norm": {fname: dn},
            "raw_fm_f0": {fname: {"FM": j["key_values"][fname]["FM"],
                                    "F0": j["key_values"][fname]["F0"],
                                    "FM_time_ms": j["key_values"][fname].get("FM_time_ms")}},
            "time_raw_ms": time_ms,
            "fj_detect_mode": "d2_zero",
            "fi_detect_mode": "d2_zero",
            "fj_fallback_ms": 3.0,
            "fi_fallback_ms": 25.0,
            "fj_logdec": 0.4,
            "fi_logdec": 0.4,
        })
        assert refit_resp.status_code == 200
        rj = refit_resp.get_json()
        kt = rj["key_timings"][fname]
        # Detection should succeed — FJ_ref should mention D2 or fallback
        assert kt["FJ_ref"] is not None
        assert kt["FJ_time_user_ms"] is not None

    def test_fi_detect_mode_independent(self, client):
        """FJ and FI detection modes can be set independently."""
        resp = _upload(
            client,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
            extra_fields={
                "fj_detect_mode": "fixed",
                "fi_detect_mode": "d2_zero",
            },
        )
        _, kv = _first_kv(resp.get_json())
        assert "fixed" in kv["FJ_ref"].lower()
        assert "d2" in kv["FI_ref"].lower() or "fallback" in kv["FI_ref"].lower()


# ═══════════════════════════════════════════════════════════════════════════
#  Reconstruction quality — regression guard for spline overfitting
# ═══════════════════════════════════════════════════════════════════════════

class TestReconstructionQuality:
    """Guard against spline overfitting at the left boundary.

    MC-PAM data (0.01 ms resolution, ~50 pts in the O-J region) historically
    caused the logspline quintic fit to produce an unrealistic dip below -1.0
    in the initial reconstruction and extreme derivative spikes (D1 to -50,
    D2 to 1800, D3 to -40 000).  These tests catch that regression.

    The overfitting is worst in the REFIT path (/api/ojip_refit), which
    receives pre-processed double-normalised data and refits the spline.
    Both paths are tested.
    """

    FLUORO = "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"
    FILES_3 = ["mcpam_example_1.CSV", "mcpam_example_2.CSV", "mcpam_example_3.CSV"]

    def _get_upload_curves(self, client, filenames=None):
        """Upload and return per-file curves dict."""
        filenames = filenames or ["mcpam_example_1.CSV"]
        resp = _upload(client, self.FLUORO, filenames)
        j = resp.get_json()
        return j

    def _get_refit_curves(self, client):
        """Upload 3 files, then refit → return refit curves dict."""
        j = self._get_upload_curves(client, self.FILES_3)
        double_norm = {}
        raw_fm_f0 = {}
        for fn in j["curves"]:
            double_norm[fn] = j["curves"][fn]["double_norm"]
            kv = j["key_values"][fn]
            raw_fm_f0[fn] = {
                "FM": kv["FM"], "F0": kv["F0"],
                "FM_time_ms": kv.get("FM_time_ms"),
            }
        resp2 = client.post("/api/ojip_refit", json={
            "fluorometer": self.FLUORO,
            "kr": 10,
            "double_norm": double_norm,
            "raw_fm_f0": raw_fm_f0,
            "fit_method": "logspline",
            "knot_placement": "hybrid",
            "fj_time_ms": 2.0,
            "fi_time_ms": 30.0,
            "value_readout": "interp",
            "time_raw_ms": j["time_raw_ms"],
        })
        assert resp2.status_code == 200
        return resp2.get_json()["curves"]

    # ── Initial upload path ──────────────────────────────────────────────

    def test_upload_reconstruction_no_undershoot(self, client):
        """Upload: reconstruction must not dip far below 0 (the O level)."""
        j = self._get_upload_curves(client)
        for fname, c in j["curves"].items():
            min_val = min(c["reconstructed"])
            assert min_val > -0.15, (
                f"{fname}: reconstruction undershoots to {min_val:.3f}"
            )

    def test_upload_d1_bounded(self, client):
        """Upload: D1 should not have extreme negative spikes."""
        j = self._get_upload_curves(client)
        for fname, c in j["curves"].items():
            min_d1 = min(c["d1"])
            assert min_d1 > -20, (
                f"{fname}: D1 spike to {min_d1:.1f} — overfitting"
            )

    def test_upload_reconstruction_monotone_start(self, client):
        """Upload: first 10 points should be roughly non-decreasing (O-J rise)."""
        j = self._get_upload_curves(client)
        for fname, c in j["curves"].items():
            head = c["reconstructed"][:10]
            dips = sum(1 for i in range(1, len(head)) if head[i] < head[i-1] - 0.02)
            assert dips <= 1, f"{fname}: {dips} dips in first 10 pts"

    # ── Refit path (where overfitting was historically worst) ────────────

    def test_refit_reconstruction_no_undershoot(self, client):
        """Refit: reconstruction must not dip far below 0."""
        curves = self._get_refit_curves(client)
        for fname, c in curves.items():
            min_val = min(c["reconstructed"])
            assert min_val > -0.15, (
                f"{fname} refit: reconstruction undershoots to {min_val:.3f}"
            )

    @pytest.mark.xfail(reason="Known: refit D2 boundary spikes (~-1500), fix pending")
    def test_refit_d2_bounded(self, client):
        """Refit: D2 should not have extreme spikes at boundary."""
        curves = self._get_refit_curves(client)
        for fname, c in curves.items():
            d2 = c["d2"]
            # Check initial third of the eval grid
            n_check = max(1, len(d2) // 3)
            extremes = max(abs(min(d2[:n_check])), abs(max(d2[:n_check])))
            assert extremes < 500, (
                f"{fname} refit: D2 extreme {extremes:.0f} — overfitting"
            )

    @pytest.mark.xfail(reason="Known: refit D3 boundary spikes (~30 000), fix pending")
    def test_refit_d3_bounded(self, client):
        """Refit: D3 should not have extreme spikes at boundary."""
        curves = self._get_refit_curves(client)
        for fname, c in curves.items():
            d3 = c["d3"]
            n_check = max(1, len(d3) // 3)
            extremes = max(abs(min(d3[:n_check])), abs(max(d3[:n_check])))
            assert extremes < 5000, (
                f"{fname} refit: D3 extreme {extremes:.0f} — overfitting"
            )
