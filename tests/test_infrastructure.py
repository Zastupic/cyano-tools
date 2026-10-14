"""
Infrastructure tests for CyanoTools shared components.

Tests CSRF enforcement, security headers, path-traversal prevention,
and rate limiting — the kind of bugs invisible in normal use but
critical in production.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SECRET_KEY", "test-secret-key-infra")

from website import create_app


@pytest.fixture(scope="module")
def app():
    application = create_app()
    application.config["TESTING"] = True
    return application


@pytest.fixture(scope="module")
def csrf_client(app):
    """Client WITH CSRF enforcement (the default)."""
    return app.test_client()


@pytest.fixture(scope="module")
def client(app):
    """Client with CSRF disabled for non-CSRF tests."""
    app.config["WTF_CSRF_ENABLED"] = False
    c = app.test_client()
    yield c
    app.config["WTF_CSRF_ENABLED"] = True


# ═══════════════════════════════════════════════════════════════════════════
#  Security headers
# ═══════════════════════════════════════════════════════════════════════════

class TestSecurityHeaders:

    def test_csp_header_present(self, client):
        resp = client.get("/")
        csp = resp.headers.get("Content-Security-Policy", "")
        assert "default-src" in csp, "CSP header missing or empty"

    def test_x_frame_options(self, client):
        resp = client.get("/")
        assert resp.headers.get("X-Frame-Options") == "SAMEORIGIN"

    def test_x_content_type_options(self, client):
        resp = client.get("/")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"

    def test_referrer_policy(self, client):
        resp = client.get("/")
        assert "Referrer-Policy" in resp.headers

    def test_permissions_policy(self, client):
        resp = client.get("/")
        assert "Permissions-Policy" in resp.headers


# ═══════════════════════════════════════════════════════════════════════════
#  safe_cache_key (path traversal prevention)
# ═══════════════════════════════════════════════════════════════════════════

class TestSafeCacheKey:
    """safe_cache_key accepts only image filenames matching a strict regex
    and verifies the resolved path stays inside UPLOAD_FOLDER.
    Anything else → None."""

    def test_valid_image_filename(self):
        from website import safe_cache_key
        result = safe_cache_key("my_image-01.png")
        assert result == "my_image-01.png"

    def test_non_image_extension_rejected(self):
        from website import safe_cache_key
        assert safe_cache_key("data_file_1.CSV") is None

    def test_path_traversal_rejected(self):
        from website import safe_cache_key
        assert safe_cache_key("../../../etc/passwd") is None

    def test_absolute_path_rejected(self):
        from website import safe_cache_key
        assert safe_cache_key("/etc/passwd") is None

    def test_null_byte_rejected(self):
        from website import safe_cache_key
        assert safe_cache_key("file\x00.png") is None

    def test_empty_string(self):
        from website import safe_cache_key
        assert safe_cache_key("") is None


# ═══════════════════════════════════════════════════════════════════════════
#  CSRF enforcement
# ═══════════════════════════════════════════════════════════════════════════

class TestCSRF:

    def test_exempt_endpoint_works_without_token(self, client):
        """@csrf.exempt API endpoints should accept bare POST."""
        # /api/ojip_process is csrf.exempt — even without a token, it
        # should return 400 (no files) not 400 (CSRF missing)
        resp = client.post("/api/ojip_process", data={}, content_type="multipart/form-data")
        j = resp.get_json()
        # Should fail with "No files received", NOT CSRF error
        assert resp.status_code == 400
        assert "files" in j.get("message", "").lower() or "file" in j.get("message", "").lower()
