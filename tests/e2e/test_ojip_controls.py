"""
E2E tests for OJIP detection mode controls — dropdown sync, enable/disable,
and reset-to-defaults behavior.

These tests catch the class of bugs where JS DOM state gets out of sync
(e.g. detection mode changed but fixed-time input stays disabled).
"""

import re


from conftest import expand_advanced_params, upload_and_analyze


# ── helpers ────────────────────────────────────────────────────────────────

def _is_enabled(locator):
    """Check that an input is not disabled."""
    return not locator.is_disabled()


def _opacity(locator):
    """Read the inline opacity style of an element."""
    style = locator.get_attribute("style") or ""
    m = re.search(r"opacity:\s*([\d.]+)", style)
    return float(m.group(1)) if m else 1.0


# ═══════════════════════════════════════════════════════════════════════════
#  FJ/FI mode ↔ input enable/disable
# ═══════════════════════════════════════════════════════════════════════════

class TestModeToggle:
    """Selecting 'Fixed timing' should enable the time input and disable logdec/fallback,
    and vice versa for detection modes."""

    def test_fj_fixed_enables_time_input(self, ojip_page):
        page = ojip_page
        expand_advanced_params(page)

        # Default is d2_zero — FJ_time should be disabled
        assert page.locator("#FJ_time").is_disabled()

        # Switch to fixed
        page.select_option("#fj-mode-sidebar", "fixed")

        # Fixed-time input should now be enabled
        assert _is_enabled(page.locator("#FJ_time"))
        # Logdec and fallback should be disabled
        assert page.locator("#fj-logdec-sidebar").is_disabled()
        assert page.locator("#fj-fallback-sidebar").is_disabled()

    def test_fj_d2zero_enables_logdec(self, ojip_page):
        page = ojip_page
        expand_advanced_params(page)

        # Switch to fixed first, then back to d2_zero
        page.select_option("#fj-mode-sidebar", "fixed")
        page.select_option("#fj-mode-sidebar", "d2_zero")

        # Logdec and fallback should be enabled
        assert _is_enabled(page.locator("#fj-logdec-sidebar"))
        assert _is_enabled(page.locator("#fj-fallback-sidebar"))
        # Fixed-time input should be disabled
        assert page.locator("#FJ_time").is_disabled()

    def test_fi_fixed_enables_time_input(self, ojip_page):
        page = ojip_page
        expand_advanced_params(page)

        assert page.locator("#FI_time").is_disabled()

        page.select_option("#fi-mode-sidebar", "fixed")

        assert _is_enabled(page.locator("#FI_time"))
        assert page.locator("#fi-logdec-sidebar").is_disabled()
        assert page.locator("#fi-fallback-sidebar").is_disabled()


# ═══════════════════════════════════════════════════════════════════════════
#  Sidebar ↔ Diagnostics two-way sync
# ═══════════════════════════════════════════════════════════════════════════

class TestDropdownSync:
    """Changing a dropdown in one location must sync to the other."""

    def test_sidebar_syncs_to_diagnostics(self, ojip_page):
        page = ojip_page
        expand_advanced_params(page)

        page.select_option("#fj-mode-sidebar", "poly_inflect")

        # Diagnostics dropdown should match
        diag_val = page.locator("#fj-detect-mode").input_value()
        assert diag_val == "poly_inflect"

    def test_diagnostics_syncs_to_sidebar(self, ojip_page):
        page = ojip_page

        # The Diagnostics dropdown is inside #results-section (hidden until upload),
        # so we need results first. Upload, then navigate to the Diagnostics tab.
        upload_and_analyze(
            page,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )
        page.locator("a[href='#tab-diag']").click()
        page.wait_for_timeout(500)

        page.select_option("#fj-detect-mode", "d2_min")

        expand_advanced_params(page)
        sidebar_val = page.locator("#fj-mode-sidebar").input_value()
        assert sidebar_val == "d2_min"

    def test_logdec_sidebar_syncs_to_diag(self, ojip_page):
        page = ojip_page
        expand_advanced_params(page)

        page.locator("#fj-logdec-sidebar").fill("0.5")
        page.locator("#fj-logdec-sidebar").dispatch_event("input")

        diag_val = page.locator("#fj-logdec").input_value()
        assert diag_val == "0.5"


# ═══════════════════════════════════════════════════════════════════════════
#  Fallback interval display
# ═══════════════════════════════════════════════════════════════════════════

class TestFallbackDisplay:

    def test_fallback_interval_updates(self, ojip_page):
        page = ojip_page
        expand_advanced_params(page)

        # Set fallback = 2.0 and logdec = 0.5
        page.locator("#fj-fallback-sidebar").fill("2.0")
        page.locator("#fj-fallback-sidebar").dispatch_event("input")
        page.locator("#fj-logdec-sidebar").fill("0.5")
        page.locator("#fj-logdec-sidebar").dispatch_event("input")

        # Interval should show [0.6 – 6.3 ms] (2/10^0.5 to 2*10^0.5)
        text = page.locator("#fj-interval-sidebar").text_content()
        assert "[" in text and "–" in text and "ms]" in text


# ═══════════════════════════════════════════════════════════════════════════
#  Reset to defaults
# ═══════════════════════════════════════════════════════════════════════════

class TestResetDefaults:

    def test_reset_restores_all_controls(self, ojip_page):
        page = ojip_page
        expand_advanced_params(page)

        # Change logdec/fallback while still in d2_zero mode (where they're enabled)
        page.locator("#fj-logdec-sidebar").fill("0.8")
        page.locator("#fj-logdec-sidebar").dispatch_event("input")
        page.locator("#fj-fallback-sidebar").fill("5.0")
        page.locator("#fj-fallback-sidebar").dispatch_event("input")
        # Then switch to fixed mode
        page.select_option("#fj-mode-sidebar", "fixed")

        # #reset-defaults-btn is in the Diagnostics tab (inside #results-section),
        # so we need results visible first. Upload, then navigate to Diagnostics tab.
        upload_and_analyze(
            page,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )
        page.locator("a[href='#tab-diag']").click()
        page.wait_for_timeout(500)

        # Click Reset to defaults
        page.locator("#reset-defaults-btn").click()

        # Verify sidebar controls restored (mode back to d2_zero, logdec/fallback re-enabled)
        assert page.locator("#fj-mode-sidebar").input_value() == "d2_zero"
        assert page.locator("#fj-logdec-sidebar").input_value() == "0.3"
        assert page.locator("#fj-fallback-sidebar").input_value() == "2.0"

        # Verify diagnostics controls also restored
        assert page.locator("#fj-detect-mode").input_value() == "d2_zero"
        assert page.locator("#fj-logdec").input_value() == "0.3"
        assert page.locator("#fj-fallback-time").input_value() == "2.0"


# ═══════════════════════════════════════════════════════════════════════════
#  Post-upload behavior
# ═══════════════════════════════════════════════════════════════════════════

class TestPostUpload:

    def test_upload_preserves_detect_mode(self, ojip_page):
        """After upload with d2_zero selected, dropdown should still show d2_zero
        and logdec/fallback should remain enabled."""
        page = ojip_page

        # Verify default is d2_zero
        assert page.locator("#fj-detect-mode").input_value() == "d2_zero"

        upload_and_analyze(
            page,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )

        # Detection mode should still be d2_zero (not forced to 'fixed')
        assert page.locator("#fj-detect-mode").input_value() == "d2_zero"

        # Logdec/fallback should still be enabled
        assert _is_enabled(page.locator("#fj-logdec"))
        assert _is_enabled(page.locator("#fj-fallback-time"))


# ═══════════════════════════════════════════════════════════════════════════
#  Console error detection
# ═══════════════════════════════════════════════════════════════════════════

class TestNoConsoleErrors:

    def test_no_errors_on_mode_switch(self, ojip_page):
        """Switching detection modes should not produce JS errors."""
        page = ojip_page
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))

        expand_advanced_params(page)

        # Cycle through all modes
        for mode in ["fixed", "d2_zero", "poly_inflect", "d2_min", "fixed"]:
            page.select_option("#fj-mode-sidebar", mode)

        assert errors == [], f"JS errors on mode switch: {errors}"

    def test_no_errors_on_upload_and_refit(self, ojip_page):
        """Upload + mode change + refit should not produce JS errors."""
        page = ojip_page
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))

        # Upload 2 files — "Refit all curves" button only shows with >1 file
        upload_and_analyze(
            page,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV", "mcpam_example_2.CSV"],
        )

        # Click Diagnostics tab first (controls are inside that tab pane)
        page.locator("a[href='#tab-diag']").click()
        page.wait_for_timeout(500)

        # Switch detection mode after upload
        page.select_option("#fj-detect-mode", "poly_inflect")

        # Click Refit
        page.locator("button", has_text="Refit all curves").click()

        # Wait for refit to complete
        page.wait_for_timeout(5000)

        assert errors == [], f"JS errors during upload/refit: {errors}"
