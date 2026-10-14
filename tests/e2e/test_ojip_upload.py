"""
E2E tests for OJIP upload flow — file upload, results rendering,
example data loading, and tab navigation.
"""



from conftest import upload_and_analyze


# ═══════════════════════════════════════════════════════════════════════════
#  Basic upload → results
# ═══════════════════════════════════════════════════════════════════════════

class TestUploadResults:

    def test_mcpam_upload_shows_results(self, ojip_page):
        page = ojip_page

        upload_and_analyze(
            page,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )

        # Results section should be visible
        assert page.locator("#results-section").is_visible()

        # Summary text should mention file count and fluorometer
        summary = page.locator("#results-summary").text_content()
        assert "1 file" in summary
        assert "MULTI-COLOR-PAM" in summary

    def test_aquapen_upload_shows_results(self, ojip_page):
        page = ojip_page

        upload_and_analyze(
            page,
            "Aquapen",
            ["aquapen_example_1.txt"],
        )

        assert page.locator("#results-section").is_visible()
        summary = page.locator("#results-summary").text_content()
        assert "1 file" in summary

    def test_results_summary_content(self, ojip_page):
        """Summary should match: 'N file(s) processed — INSTRUMENT — FJ X ms / FI Y ms'"""
        page = ojip_page

        upload_and_analyze(
            page,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV", "mcpam_example_2.CSV"],
        )

        summary = page.locator("#results-summary").text_content()
        assert "2 file" in summary
        assert "FJ" in summary
        assert "FI" in summary
        assert "ms" in summary


# ═══════════════════════════════════════════════════════════════════════════
#  Example data button
# ═══════════════════════════════════════════════════════════════════════════

class TestExampleData:

    def test_example_data_button_loads_results(self, ojip_page):
        """Clicking 'Try with example data' should load data and show results."""
        page = ojip_page

        page.locator("button", has_text="Try with example data").click()

        # Wait for results to appear (example data triggers automatic analysis)
        page.wait_for_selector(
            "#results-section", state="visible", timeout=45000
        )

        summary = page.locator("#results-summary").text_content()
        assert "processed" in summary or "file" in summary


# ═══════════════════════════════════════════════════════════════════════════
#  Tab switching
# ═══════════════════════════════════════════════════════════════════════════

class TestTabNavigation:

    def test_tab_switching_no_errors(self, ojip_page):
        """After upload, clicking each tab should work without JS errors."""
        page = ojip_page
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))

        upload_and_analyze(
            page,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV"],
        )

        # Click through each tab
        for tab_href in ["#tab-curves", "#tab-params", "#tab-diag", "#tab-groups"]:
            page.locator(f"a[href='{tab_href}']").click()
            page.wait_for_timeout(500)

        assert errors == [], f"JS errors during tab switching: {errors}"


# ═══════════════════════════════════════════════════════════════════════════
#  Refit
# ═══════════════════════════════════════════════════════════════════════════

class TestRefit:

    def test_refit_updates_without_errors(self, ojip_page):
        """Upload → Diagnostics → Refit should complete without errors."""
        page = ojip_page
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))

        # Upload 2 files — "Refit all curves" button only shows with >1 file
        upload_and_analyze(
            page,
            "MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)",
            ["mcpam_example_1.CSV", "mcpam_example_2.CSV"],
        )

        # Go to Diagnostics tab
        page.locator("a[href='#tab-diag']").click()
        page.wait_for_timeout(500)

        # Click Refit
        page.locator("button", has_text="Refit all curves").click()

        # Wait for refit to complete
        page.wait_for_timeout(5000)

        # Results should still be visible
        assert page.locator("#results-section").is_visible()
        assert errors == [], f"JS errors during refit: {errors}"
