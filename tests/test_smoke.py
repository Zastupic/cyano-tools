"""
Smoke tests for all CyanoTools analysis tools.

Each test uploads a real fixture/example file to the tool's API endpoint and
verifies: status 200, response has expected top-level keys, no server errors.
This catches broken imports, misconfigured routes, and parser regressions
across the entire application — not just OJIP.

Example files are sourced from website/static/files/examples/<tool>/ or
tests/fixtures/ (whichever has data for that tool).
"""

import io
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SECRET_KEY", "test-secret-key-smoke")

from website import create_app

ROOT = os.path.join(os.path.dirname(__file__), "..")
EXAMPLES = os.path.join(ROOT, "website", "static", "files", "examples")
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
IMAGES = os.path.join(ROOT, "website", "static", "images")


@pytest.fixture(scope="module")
def app():
    application = create_app(testing=True)
    application.config["WTF_CSRF_ENABLED"] = False
    return application


@pytest.fixture(scope="module")
def client(app):
    return app.test_client()


def _read(path):
    with open(path, "rb") as f:
        return f.read()


def _upload_files(client, endpoint, file_field, file_paths, extra_fields=None):
    """POST multipart files and return the response."""
    data = {}
    if extra_fields:
        data.update(extra_fields)
    files = []
    for p in file_paths:
        raw = _read(p)
        files.append((io.BytesIO(raw), os.path.basename(p)))
    data[file_field] = files
    return client.post(endpoint, data=data, content_type="multipart/form-data")


# ═══════════════════════════════════════════════════════════════════════════
#  Light Curves
# ═══════════════════════════════════════════════════════════════════════════

class TestLightCurvesSmoke:

    def test_aquapen_lc3_upload(self, client):
        lc_dir = os.path.join(EXAMPLES, "light_curves")
        files = [os.path.join(lc_dir, f) for f in os.listdir(lc_dir) if f.endswith(".txt")]
        assert len(files) >= 1, "No light curve example files found"

        resp = _upload_files(
            client, "/api/lc_process", "light_curve_files", files[:3],
            extra_fields={
                "fluorometer": "AquaPen",
                "protocol": "LC3",
                "etr_max_factor": "10",
                "negative_etr_mode": "clip_zero",
            },
        )
        assert resp.status_code == 200, f"Light curves upload failed: {resp.data[:500]}"
        j = resp.get_json()
        assert j.get("status") == "success"


# ═══════════════════════════════════════════════════════════════════════════
#  Slow Kinetics (NPQ)
# ═══════════════════════════════════════════════════════════════════════════

class TestSlowKinSmoke:

    def test_aquapen_npq1_upload(self, client):
        npq_dir = os.path.join(EXAMPLES, "slow_kin", "AquaPen")
        files = [os.path.join(npq_dir, f) for f in sorted(os.listdir(npq_dir)) if f.endswith(".txt")]
        assert len(files) >= 1, "No slow_kin AquaPen example files found"

        resp = _upload_files(
            client, "/api/slow_kin_process", "NPQ_files", files[:3],
            extra_fields={
                "fluorometer": "AquaPen",
                "aquapen_protocol": "NPQ1",
            },
        )
        assert resp.status_code == 200, f"Slow kin AquaPen upload failed: {resp.data[:500]}"
        j = resp.get_json()
        assert j.get("status") == "success"

    def test_mcpam_params_upload(self, client):
        npq_dir = os.path.join(EXAMPLES, "slow_kin", "MC-PAM")
        files = [os.path.join(npq_dir, f) for f in sorted(os.listdir(npq_dir)) if f.upper().endswith(".CSV")]
        assert len(files) >= 1, "No slow_kin MC-PAM example files found"

        resp = _upload_files(
            client, "/api/slow_kin_process", "NPQ_files", files[:3],
            extra_fields={
                "fluorometer": "MC-PAM",
                "mc_pam_file_type": "parameters",
            },
        )
        assert resp.status_code == 200, f"Slow kin MC-PAM upload failed: {resp.data[:500]}"
        j = resp.get_json()
        assert j.get("status") == "success"


# ═══════════════════════════════════════════════════════════════════════════
#  EEM / Fluorescence Spectra
# ═══════════════════════════════════════════════════════════════════════════

class TestEEMSmoke:

    def test_77k_csv_upload(self, client):
        eem_dir = os.path.join(EXAMPLES, "eem")
        files = [os.path.join(eem_dir, f) for f in sorted(os.listdir(eem_dir)) if f.endswith(".csv")]
        assert len(files) >= 1, "No EEM example files found"

        resp = _upload_files(
            client, "/api/eem_process", "77K_files", files[:3],
            extra_fields={
                "spectrofluorometer": "jasco",
                "analysis_mode": "77K",
                "checkbox_pigmentation": "checkbox_chl_only",
            },
        )
        assert resp.status_code == 200, f"EEM upload failed: {resp.data[:500]}"
        j = resp.get_json()
        # EEM returns a dict with spectra data (no standard "status" key)
        assert isinstance(j, dict)
        assert "error" not in j


# ═══════════════════════════════════════════════════════════════════════════
#  Sigma(II) Analysis
# ═══════════════════════════════════════════════════════════════════════════

class TestSigmaSmoke:

    def test_sigma_csv_upload(self, client):
        sigma_dir = os.path.join(EXAMPLES, "sigma")
        files = [os.path.join(sigma_dir, f) for f in sorted(os.listdir(sigma_dir)) if f.endswith(".csv")]
        assert len(files) >= 1, "No sigma example files found"

        resp = _upload_files(
            client, "/api/sigma_process", "files", files[:3],
        )
        assert resp.status_code == 200, f"Sigma upload failed: {resp.data[:500]}"
        j = resp.get_json()
        assert isinstance(j, dict)
        assert "error" not in j


# ═══════════════════════════════════════════════════════════════════════════
#  GET page rendering (all tools)
# ═══════════════════════════════════════════════════════════════════════════

class TestPageRendering:
    """Every tool's GET page should render without a 500 error."""

    @pytest.mark.parametrize("path", [
        "/",
        "/OJIP",
        "/NPQ",
        "/RapidLightCurves",
        "/EEM",
        "/sigma",
        "/MIMS",
        "/MIMS_data_analysis_periodic",
        "/statistics",
        "/calculators",
        "/cell_count",
        "/cell_count_filament",
        "/cell_size_round_cells",
        "/cell_size_filament",
        "/pixel_profiles_round_cells",
        "/pixel_profiles_filament",
        "/PBR",
        "/P700_kin_data_analysis",
    ])
    def test_page_loads(self, client, path):
        resp = client.get(path)
        assert resp.status_code == 200, f"GET {path} returned {resp.status_code}"
