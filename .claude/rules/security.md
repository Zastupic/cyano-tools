---
paths:
  - "website/__init__.py"
  - "website/auth.py"
  - "website/views.py"
  - "website/shared.py"
  - "website/models.py"
---
# Security Rules
- NEVER add an external host (script/style/font/img/connect) without updating
  the CSP in set_security_headers() in website/__init__.py.
- JSON API endpoints called from JS MUST be @csrf.exempt.
- Validate any user-supplied filename with safe_cache_key() — never build a
  filesystem path from raw user input (path-traversal guard).
- Upload handlers MUST validate file type/extension before processing.
- NEVER persist user-uploaded scientific data — privacy by design.
- NEVER add a pip or npm dependency without asking the developer first
  (AI models suggest non-existent packages that attackers can register).
- NEVER send raw transients/images to an external LLM — only named scalar params.
