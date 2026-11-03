Run scoped verification for a tool.

Tool name: $ARGUMENTS

1. Syntax-check the Python module:
   python -m py_compile website/$ARGUMENTS.py
2. If website/static/js_$ARGUMENTS.js exists, check JS syntax:
   node --check website/static/js_$ARGUMENTS.js
3. Run scoped tests:
   pytest -m "$ARGUMENTS or smoke or infrastructure" tests/ -v
4. If no marker matches $ARGUMENTS, fall back to:
   pytest tests/test_smoke.py tests/test_infrastructure.py -v
5. Report pass/fail summary.
