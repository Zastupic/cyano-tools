"""
Shared fixtures and helpers for CyanoTools test suite.

Provides session-scoped app/client fixtures as defaults for test files
that don't define their own.  Existing test modules with module-scoped
fixtures (test_smoke.py, test_infrastructure.py, etc.) shadow these
automatically — no changes needed there.

Also exports path constants and upload helpers used across multiple
test files.
"""

import io
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SECRET_KEY", "test-secret-key-shared")

from website import create_app

# ── Path constants ──────────────────────────────────────────────────────
ROOT = os.path.join(os.path.dirname(__file__), "..")
EXAMPLES = os.path.join(ROOT, "website", "static", "files", "examples")
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
IMAGES = os.path.join(ROOT, "website", "static", "images")


# ── Default app / client fixtures ───────────────────────────────────────
@pytest.fixture(scope="session")
def app():
    """Session-scoped Flask app with CSRF disabled (default for most tests)."""
    application = create_app(testing=True)
    application.config["WTF_CSRF_ENABLED"] = False
    return application


@pytest.fixture(scope="session")
def client(app):
    return app.test_client()


# ── Upload helpers ──────────────────────────────────────────────────────
def _read(path):
    """Read a file as bytes."""
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
