"""
Playwright E2E test configuration.

Starts a Flask dev server on port 5099 (session-scoped) and provides
page fixtures for browser-based tests.

Usage:
    pytest tests/e2e/ -v              # headless (CI/default)
    pytest tests/e2e/ -v --headed     # watch in browser
    pytest tests/e2e/ -v --headed --slowmo=500  # slow motion
"""

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parent.parent.parent  # Flask_server/
FIXTURES = ROOT / "tests" / "fixtures"
PORT = 5099


def _port_open(port, host="127.0.0.1"):
    """Check if a TCP port is accepting connections."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


@pytest.fixture(scope="session")
def base_url():
    """Start Flask dev server once for the whole E2E test session.

    Uses port 5099 to avoid collision with a running dev server on 5000.
    If 5099 is already open (e.g. manually started for --headed debugging),
    reuses it instead of starting a new one.
    """
    url = f"http://127.0.0.1:{PORT}"

    if _port_open(PORT):
        # Server already running — reuse it
        yield url
        return

    env = os.environ.copy()
    env["SECRET_KEY"] = "e2e-test-key"

    proc = subprocess.Popen(
        [
            sys.executable, "-c",
            "from website import create_app; "
            f"create_app().run(port={PORT}, debug=False, use_reloader=False, threaded=True)",
        ],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Wait for server readiness (up to 15 seconds)
    for _ in range(60):
        if _port_open(PORT):
            break
        time.sleep(0.25)
    else:
        proc.terminate()
        raise RuntimeError(f"Flask server did not start on port {PORT}")

    # Warmup: make an HTTP request to ensure Flask has fully initialised
    # (first request can be slow due to template compilation, imports, etc.)
    for _ in range(20):
        try:
            requests.get(url + "/OJIP", timeout=10)
            break
        except requests.ConnectionError:
            time.sleep(0.5)

    yield url

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture
def page(browser, base_url):
    """Create a fresh browser context and page for each test."""
    context = browser.new_context(base_url=base_url)
    pg = context.new_page()
    yield pg
    context.close()


@pytest.fixture
def ojip_page(page):
    """Navigate to the OJIP page and wait for it to be ready."""
    # Use domcontentloaded — the OJIP page loads heavy CDN scripts (plotly ~3MB,
    # sheetjs, bootstrap) that can exceed the default 30s "load" timeout.
    # The DOM and our app JS are ready well before all CDN resources finish.
    page.goto("/OJIP", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("#analyze-btn", state="visible", timeout=15000)
    return page


def expand_advanced_params(page):
    """Expand the 'Additional analysis parameters' collapsible section."""
    toggle = page.locator("[data-target='#advancedParams']")
    # Only click if not already expanded
    section = page.locator("#advancedParams")
    if not section.is_visible():
        toggle.click()
        section.wait_for(state="visible", timeout=3000)


def upload_and_analyze(page, fluorometer, fixture_files, timeout=30000):
    """Select fluorometer, upload fixture files, click Analyze, wait for results.

    Args:
        page: Playwright page (already on /OJIP).
        fluorometer: Full fluorometer string (e.g. "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)").
        fixture_files: List of fixture filenames (relative to tests/fixtures/).
        timeout: Max wait for results (ms).
    """
    page.select_option("#fluorometer", fluorometer)

    paths = [str(FIXTURES / f) for f in fixture_files]
    page.locator("#ojip-files").set_input_files(paths)

    page.locator("#analyze-btn").click()
    page.wait_for_selector("#results-section", state="visible", timeout=timeout)
