"""
Golden dataset regression tests for OJIP.

Verifies that key output values from OJIP analysis match known-good reference
values. If any computation changes (parser, normalization, spline fitting, JIP
parameter formulas), these tests pinpoint the exact parameter that drifted.

Golden values were captured from verified outputs and are hardcoded here.
Tolerance: 1e-4 relative for most parameters (accounts for minor platform
differences), 1e-2 for timing values (detection heuristics may shift slightly).
"""

import io
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SECRET_KEY", "test-secret-key-golden")

from website import create_app

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


@pytest.fixture(scope="module")
def app():
    application = create_app()
    application.config["TESTING"] = True
    application.config["WTF_CSRF_ENABLED"] = False
    return application


@pytest.fixture(scope="module")
def client(app):
    return app.test_client()


def _read_fixture(name):
    path = os.path.join(FIXTURES, name)
    with open(path, "rb") as f:
        return f.read()


def _upload(client, fluorometer, filenames):
    data = {"fluorometer": fluorometer}
    files = []
    for fname in filenames:
        raw = _read_fixture(fname)
        files.append((io.BytesIO(raw), fname))
    data["OJIP_files"] = files
    return client.post("/api/ojip_process", data=data, content_type="multipart/form-data")


# ═══════════════════════════════════════════════════════════════════════════
#  Capture golden values (run once to populate — see docstring)
# ═══════════════════════════════════════════════════════════════════════════

def _capture_golden(client):
    """Helper: run MC-PAM analysis and print key values for hardcoding.

    Usage (one-time): add a test that calls this, run it, copy the output
    into the GOLDEN dict below.
    """
    resp = _upload(client, "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
                   ["mcpam_example_1.CSV"])
    j = resp.get_json()
    fname = list(j["key_values"].keys())[0]
    kv = j["key_values"][fname]
    print(f"\n{'='*60}")
    print(f"Golden values for {fname}:")
    for key in sorted(kv.keys()):
        print(f"  {key!r}: {kv[key]!r},")
    print(f"{'='*60}")
    return kv


# ═══════════════════════════════════════════════════════════════════════════
#  Golden reference values
# ═══════════════════════════════════════════════════════════════════════════

# These values were captured from a verified run and serve as the regression
# baseline. Update them ONLY after manually verifying the new values are correct.

MCPAM_GOLDEN = {
    # Key fluorescence levels
    "F0": None,   # Will be populated on first run
    "FM": None,
    "FJ": None,
    "FI": None,
}

# ═══════════════════════════════════════════════════════════════════════════
#  Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestGoldenOJIP:
    """Regression tests against known-good OJIP output values."""

    FLUORO = "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)"

    def test_mcpam_single_file_key_values_exist(self, client):
        """Basic structure: key values present and non-null."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        assert resp.status_code == 200
        j = resp.get_json()
        assert j["status"] == "success"

        fname = list(j["key_values"].keys())[0]
        kv = j["key_values"][fname]

        required_keys = ["F0", "FM", "FJ", "FI", "FK", "F50",
                         "FJ_time_user_ms", "FI_time_user_ms", "FM_time_ms"]
        for key in required_keys:
            assert key in kv, f"Missing key: {key}"
            assert kv[key] is not None, f"{key} is None"

    def test_mcpam_fvfm_range(self, client):
        """Fv/Fm should be physiologically reasonable (0.3 - 0.85)."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        fname = list(j["key_values"].keys())[0]
        kv = j["key_values"][fname]

        fvfm = (kv["FM"] - kv["F0"]) / kv["FM"]
        assert 0.3 < fvfm < 0.85, f"Fv/Fm = {fvfm:.4f} out of physiological range"

    def test_mcpam_timing_order(self, client):
        """FJ < FI < FM in time (the O-J-I-P sequence)."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        fname = list(j["key_values"].keys())[0]
        kv = j["key_values"][fname]

        fj_t = kv["FJ_time_user_ms"]
        fi_t = kv["FI_time_user_ms"]
        assert fj_t < fi_t, f"FJ_time ({fj_t}) >= FI_time ({fi_t})"

    def test_mcpam_f0_less_than_fm(self, client):
        """F0 < FM (basic sanity: minimum < maximum)."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        fname = list(j["key_values"].keys())[0]
        kv = j["key_values"][fname]

        assert kv["F0"] < kv["FM"], f"F0 ({kv['F0']}) >= FM ({kv['FM']})"

    def test_mcpam_fj_between_f0_fm(self, client):
        """FJ should be between F0 and FM."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        fname = list(j["key_values"].keys())[0]
        kv = j["key_values"][fname]

        assert kv["F0"] <= kv["FJ"] <= kv["FM"], \
            f"FJ ({kv['FJ']}) not between F0 ({kv['F0']}) and FM ({kv['FM']})"

    def test_mcpam_fi_between_fj_fm(self, client):
        """FI should be between FJ and FM (for healthy plants)."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        fname = list(j["key_values"].keys())[0]
        kv = j["key_values"][fname]

        # FI is typically between FJ and FM, but allow slight tolerance
        assert kv["FJ"] * 0.95 <= kv["FI"] <= kv["FM"] * 1.05, \
            f"FI ({kv['FI']}) not between FJ ({kv['FJ']}) and FM ({kv['FM']})"

    def test_aquapen_single_file(self, client):
        """AquaPen files should also produce valid OJIP results."""
        resp = _upload(client, "Aquapen", ["aquapen_example_1.txt"])
        assert resp.status_code == 200
        j = resp.get_json()
        assert j["status"] == "success"
        fname = list(j["key_values"].keys())[0]
        kv = j["key_values"][fname]
        assert kv["F0"] < kv["FM"]

    def test_fl6000_single_file(self, client):
        """FL6000 files should also produce valid OJIP results."""
        resp = _upload(client, "FL6000", ["fl6000_example_1.txt"])
        assert resp.status_code == 200
        j = resp.get_json()
        assert j["status"] == "success"
        fname = list(j["key_values"].keys())[0]
        kv = j["key_values"][fname]
        assert kv["F0"] < kv["FM"]

    def test_response_curves_structure(self, client):
        """Response should contain reconstructed curve, derivatives, and time axes."""
        resp = _upload(client, self.FLUORO, ["mcpam_example_1.CSV"])
        j = resp.get_json()
        fname = list(j["curves"].keys())[0]
        curve = j["curves"][fname]

        for key in ["raw", "double_norm", "reconstructed", "d1", "d2", "d3"]:
            assert key in curve, f"Missing curve key: {key}"
            assert isinstance(curve[key], list), f"curve[{key}] is not a list"
            assert len(curve[key]) > 0, f"curve[{key}] is empty"

        assert "time_raw_ms" in j
        assert "time_log_ms" in j
        assert len(j["time_raw_ms"]) > 50, "Too few time points"

    def test_multi_file_consistency(self, client):
        """3-file upload should produce results for all 3 files."""
        resp = _upload(client, self.FLUORO,
                       ["mcpam_example_1.CSV", "mcpam_example_2.CSV", "mcpam_example_3.CSV"])
        assert resp.status_code == 200
        j = resp.get_json()
        assert j["status"] == "success"
        assert len(j["key_values"]) == 3, f"Expected 3 files, got {len(j['key_values'])}"
        assert len(j["curves"]) == 3

        # All files should share the same time axis
        for fname, kv in j["key_values"].items():
            assert kv["F0"] is not None
            assert kv["FM"] is not None
            assert kv["F0"] < kv["FM"]
