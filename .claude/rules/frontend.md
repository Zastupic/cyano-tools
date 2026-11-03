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

# UX & Visual Consistency Rules

## Design tokens — use them
- Always use CSS custom properties from css_main.css (--color-brand, --text-xs,
  --space-*, --radius-*, --shadow-*, --transition-*). Never hardcode colours,
  font sizes, or spacing with inline styles when a token or utility class exists.
- Brand colour is --color-brand (#00b894), accent is --color-accent (#15455c).
  Avoid raw Bootstrap colour literals (#28a745, #007bff) in new templates.

## Layout & information architecture
- **Progressive disclosure:** lead with a KPI / summary row, then trends,
  then detail tables. Most important numbers at the top; raw data at the bottom.
- **Logical grouping:** keep related data together (e.g., all bot/quality
  metrics in one section, all traffic-origin data in one section).
- **Consistent time windows:** if a page uses tabbed time periods, use the
  same set (Today / 7d / 30d / Year) across all sections on that page.

## Heading hierarchy & semantics
- Use proper heading levels: h2 → h3 → h4. Never skip levels (h3 → h6).
- Use <section> elements to wrap logical groups where appropriate.
- Consolidate repeated disclaimer/methodology text into one place.

## Inline styles
- Prefer CSS classes over inline style= attributes. If a pattern appears
  more than once, extract it into a class in css_main.css.
- For one-off layout tweaks that don't warrant a class, inline is acceptable,
  but keep them minimal.

## Accessibility
- Charts/heatmaps: provide aria-labels or text alternatives so that values
  are accessible to screen readers, not only via colour.
- Ensure keyboard navigability for all interactive elements (tabs, toggles).

## Performance
- Lazy-initialise Chart.js / Plotly charts in hidden tabs — only render
  when the tab is first activated.
- Avoid loading large JS libraries that are unused on a given page.
