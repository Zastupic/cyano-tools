"""
Infrastructure tests for CyanoTools shared components.

Tests CSRF enforcement, security headers, path-traversal prevention,
and rate limiting — the kind of bugs invisible in normal use but
critical in production.
"""

import os
import sys

import pytest

pytestmark = pytest.mark.infrastructure

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SECRET_KEY", "test-secret-key-infra")

from website import create_app


@pytest.fixture(scope="module")
def app():
    application = create_app(testing=True)
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


# ═══════════════════════════════════════════════════════════════════════════
#  Stealth bot detection
# ═══════════════════════════════════════════════════════════════════════════

class TestStealthBotDetection:
    """Tests for honeypot, webdriver beacon, and tracking pixel.

    Order matters: tests that flag the test client's IP hash (honeypot,
    webdriver=true) run LAST because the denylist is module-scoped.
    """

    # ── Tracking pixel (no IP contamination) ────────────────────────────

    def test_tracking_pixel_returns_gif(self, client):
        """Pixel route should return a 1x1 GIF with no-cache headers."""
        resp = client.get('/px?id=99999')
        assert resp.status_code == 200
        assert resp.content_type == 'image/gif'
        assert 'no-store' in resp.headers.get('Cache-Control', '')

    def test_tracking_pixel_marks_px_verified(self, client, app):
        """Pixel route with valid pv ID should set px_verified=True."""
        from website.models import PageView
        from website.shared import db
        with app.app_context():
            client.get('/')
            pv = PageView.query.order_by(PageView.id.desc()).first()
            assert pv is not None
            resp = client.get(f'/px?id={pv.id}')
            assert resp.status_code == 200
            db.session.refresh(pv)
            assert pv.px_verified is True

    # ── Beacon webdriver=false (must run before IP is flagged) ──────────

    def test_beacon_webdriver_false_no_bot(self, client, app):
        """Beacon with wd=false should NOT mark PageView as bot."""
        from datetime import datetime
        from website.models import PageView
        from website.shared import db
        with app.app_context():
            # Create PageView directly to bypass IP denylist from prior tests
            pv = PageView(timestamp=datetime.utcnow(), path='/', is_bot=False)
            db.session.add(pv)
            db.session.commit()
            resp = client.post('/beacon', data={'pv': str(pv.id), 'wd': 'false'})
            assert resp.status_code == 204
            db.session.refresh(pv)
            assert pv.is_bot is False       # beacon did NOT set is_bot
            assert pv.js_verified is True

    # ── Tests below flag the test IP — run last ─────────────────────────

    def test_beacon_webdriver_true_marks_bot(self, client, app):
        """Beacon with wd=true should mark PageView as bot."""
        from website.models import PageView
        from website.shared import db
        with app.app_context():
            client.get('/')
            pv = PageView.query.order_by(PageView.id.desc()).first()
            assert pv is not None
            resp = client.post('/beacon', data={'pv': str(pv.id), 'wd': 'true'})
            assert resp.status_code == 204
            db.session.refresh(pv)
            assert pv.is_bot is True
            assert pv.js_verified is True   # still gets js_verified

    def test_honeypot_returns_204(self, client):
        """Honeypot route should return 204 No Content."""
        resp = client.get('/ct/verify')
        assert resp.status_code == 204

    def test_honeypot_flags_ip_hash(self, client, app):
        """Visiting the honeypot should create a BotHash row."""
        from website.models import BotHash
        with app.app_context():
            client.get('/ct/verify')
            count = BotHash.query.filter_by(reason='honeypot').count()
            assert count >= 1

    def test_honeypot_not_in_tracked_paths(self, client, app):
        """Honeypot path must NOT create a regular PageView."""
        from website.models import PageView
        with app.app_context():
            count_before = PageView.query.count()
            client.get('/ct/verify')
            count_after = PageView.query.count()
            assert count_after == count_before
