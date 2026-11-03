---
paths:
  - "website/templates/*.html"
  - "website/static/*.js"
  - "website/static/*.css"
---
# Frontend Rules
- After editing a JS file, verify syntax: node --check <file>
- This project uses Bootstrap 4: data-toggle="tab", NOT data-bs-toggle.
- CDN libraries already in CSP: Chart.js, Plotly, SheetJS (xlsx.mini.js),
  OpenCV.js, MathJax. Adding a new CDN source requires updating CSP in
  website/__init__.py set_security_headers().
- "Try with example data" pattern: see CLAUDE.md. Reference implementation
  is PBR Analysis (js_pbr_analysis.js, pbr_analysis.html).
- Plotly charts: white background plugin, responsive, legend toggles.
