# CyanoTools (cyano.tools)

Free, no-login web platform for cyanobacteria / microalgae / plant lab data analysis
(PAM fluorometry, spectroscopy, MIMS, microscopy image analysis, metabolic modelling,
statistics, calculators). Raw instrument files in → publication-ready `.xlsx`/plots out.
Deployed on PythonAnywhere at https://www.cyano.tools. Built at DoAB, CzechGlobe (CAS).

## Run / test
- **Dev server:** `python main.py` (reads `.env` via python-dotenv; `debug=True`, auto-reloads).
  Requires `SECRET_KEY` env var or startup raises. `FLASK_DEBUG` not needed — main.py sets debug.
- **Tests:** `pytest tests/` (currently only `test_ojip_interpretation.py`).
- Stack: Flask 2.3+ / SQLAlchemy 2 / numpy / scipy / pandas / matplotlib / opencv-headless / cobra.
  Full pin list in `requirements.txt`.

## The one pattern that matters — every tool is an independent blueprint
Each analysis tool = a self-contained trio, wired together only in `website/__init__.py`:

    website/<tool>.py            # Blueprint: routes + all analysis logic
    website/templates/<tool>.html
    website/static/js_<tool>.js  # heavy client-side logic (Plotly plots, SheetJS export)

**To add a tool:** create the trio, `from .<tool> import <bp>` + `app.register_blueprint(<bp>, url_prefix='/')`
in `create_app()`, and add its GET path to `TRACKED_PATHS` if you want page-view logging.
Tools are otherwise decoupled — work on one without touching the others.

## Shared infrastructure (in website/__init__.py unless noted)
- `shared.py` → the single `db` (SQLAlchemy) instance; `models.py` → `User`, `PageView`.
- **CSRF:** `flask_wtf.CSRFProtect` is global. JSON API endpoints called from JS must be
  `@csrf.exempt` (import `csrf` from the package) — otherwise POSTs 400.
- **Rate limiting:** global `limiter` (200/min, 2000/hr). Import to override per-route.
- **Uploads:** `UPLOAD_FOLDER = website/static/uploads/`; a daemon thread deletes files >30 min old.
  `MAX_CONTENT_LENGTH = 100 MB` (large OJIP/light-curve batches). Validate any user filename with
  `safe_cache_key()` — never build a path from raw user input (path-traversal guard).
- **Security headers + CSP** are set in `set_security_headers()`. Adding a new CDN host (script/style/
  font/img/connect) REQUIRES editing that CSP string or the browser will block it.
- Prod cookie flags (`SECURE`) key off `app.debug`, so they relax automatically in local dev.

## Never do
- **Never persist user-uploaded scientific data** — "privacy by design" is a headline promise.
  Data is processed in-session; only anonymised `PageView` rows (salted-hashed IP) are stored.
- **Never** add an external host to any page without updating the CSP in `set_security_headers()`.
- **Never** send raw transients/images to an external LLM — only named scalar params (see ojip.md).

## Per-tool notes (loaded on demand — read only when working that tool)
Most tools are small/self-evident; read `website/<tool>.py` directly. Docs exist only where
there's non-obvious domain logic worth not re-deriving:
- **OJIP / JIP-test** → `.claude/docs/ojip.md`

_(Grow this list reactively: when a session on some tool would clearly have gone faster with
notes, write `.claude/docs/<tool>.md` at the end of it. Likely future candidates: statistics.py,
fluorescence_annotation.py, metabolic_model.py, the MIMS pair.)_
