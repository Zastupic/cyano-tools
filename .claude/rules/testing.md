---
description: "Test scope and discipline"
---
# Test Execution Rules

## Scope mapping — run only relevant tests per change
- website/OJIP*.py, js_OJIP.js, templates/OJIP* → `pytest -m ojip tests/`
- website/statistics.py, js_statistics.js → `pytest -m statistics tests/`
- website/ex_em_spectra*.py, js_ex_em*.js → `pytest -m eem tests/`
- website/__init__.py, shared.py, models.py → `pytest tests/` (full suite)
- website/views.py, templates/site_stats.html → `pytest -m "smoke or infrastructure" tests/`
- Any single tool .py/.html/.js not listed above → `pytest -m "smoke or infrastructure" tests/`
- website/static/*.css, templates/base.html → `pytest -m "smoke or infrastructure" tests/`

## Discipline
- NEVER run the full test suite for changes isolated to a single tool.
- NEVER modify, delete, weaken, or disable an existing test to make it pass.
- Bug fix: write a failing test reproducing the bug FIRST, then fix.
- Refactoring: pin current outputs with a golden test FIRST, then refactor.
- New feature: write a smoke test alongside implementation.
- Human review stays mandatory for statistical methods and data-privacy logic.
