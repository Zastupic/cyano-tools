Create a new CyanoTools analysis blueprint.

Tool name: $ARGUMENTS

1. Create website/$ARGUMENTS.py with:
   - Blueprint named after the tool
   - GET route serving the template
   - POST API route (csrf.exempt) with basic file-upload handling
   - safe_cache_key() for any user filenames
2. Create website/templates/$ARGUMENTS.html extending base.html
   with the standard card layout and file input
3. Create website/static/js_$ARGUMENTS.js with:
   - loadExampleData() pattern (see PBR reference implementation)
   - Basic Plotly chart placeholder
4. In website/__init__.py:
   - Add import: from .$ARGUMENTS import <bp>
   - Add: app.register_blueprint(<bp>, url_prefix='/')
   - Add GET path to TRACKED_PATHS
5. Add a smoke test in tests/test_smoke.py for the new endpoint
6. Run: pytest -m "smoke or infrastructure" tests/ -v
7. Verify node --check on the new JS file
