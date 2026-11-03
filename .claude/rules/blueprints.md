---
description: "Blueprint pattern for all analysis tools"
---
# Blueprint Trio Pattern
Each analysis tool = a self-contained trio:
- website/<tool>.py           — Blueprint: routes + analysis logic
- website/templates/<tool>.html — Template extending base.html
- website/static/js_<tool>.js  — Client-side logic (Plotly, SheetJS)

## Adding a new tool checklist
1. Create the three files above
2. In website/__init__.py: from .<tool> import <bp>
3. app.register_blueprint(<bp>, url_prefix='/')
4. Add GET path to TRACKED_PATHS if page-view logging desired
5. Add smoke test in tests/test_smoke.py
6. Tools are decoupled — work on one without touching others
