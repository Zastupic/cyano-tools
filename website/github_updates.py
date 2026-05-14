"""
Fetches last-commit dates per tool file from GitHub and caches results for 6 hours.
Used to drive the 'Updated' badge on the home page.
"""
import urllib.request
import urllib.parse
import json
from datetime import datetime, timedelta, timezone

GITHUB_REPO    = "Zastupic/cyano-tools"
BADGE_DAYS     = 21   # "Updated" badge visible this many days after the last commit to the tool file
NEW_BADGE_DAYS = 60   # "New" badge visible this many days after the tool's addition date
_CACHE_TTL     = timedelta(hours=6)

# Map home-page tile key → list of repo paths to track (badge shows if any was recently committed)
# Tracks .py (backend logic) and .js (frontend features); .html excluded (minor layout changes too frequent)
TOOL_FILES = {
    'light_curves':            ['website/light_curves_analysis.py',      'website/static/js_light_curves.js'],
    'ojip':                    ['website/OJIP_data_analysis.py',          'website/static/js_OJIP.js'],
    'slow_kin':                ['website/slow_kin_data_analysis.py',      'website/static/js_slow_kin_analysis.js'],
    'ex_em':                   ['website/ex_em_spectra_analysis.py',      'website/static/js_ex_em_spectra_analysis.js'],
    'mims':                    ['website/MIMS_data_analysis.py',          'website/static/js_MIMS.js'],
    'statistics':              ['website/statistics.py',                  'website/static/js_statistics.js'],
    'calculators':             ['website/calculators.py',                 'website/static/js_calculators.js'],
    'cell_count':              ['website/cell_count.py',                  'website/static/js_cell_count_round_cells.js'],
    'cell_count_filament':     ['website/cell_count_filament.py',         'website/static/js_cell_count_filament.js'],
    'cell_size':               ['website/cell_size_round_cells.py',       'website/static/js_cell_size_round_cells.js'],
    'cell_size_filament':      ['website/cell_size_filament.py',          'website/static/js_cell_size_filament.js'],
    'cell_morphology_filament':['website/cell_morphology_filament.py',    'website/static/js_cell_morphology_filament.js'],
    'pixel_profiles':          ['website/pixel_profiles_round_cells.py',  'website/static/js_pixel_profies_round_cells.js'],
    'pixel_profiles_filament': ['website/pixel_profiles_filament.py',     'website/static/js_pixel_profies_filaments.js'],
    'metabolic_model':         ['website/metabolic_model.py',              'website/static/js_metabolic_model.js'],
    'sigma':                   ['website/sigma_analysis.py',               'website/static/js_sigma.js'],
}

# Static addition dates for tools — used to drive the "New" badge.
# Date format: 'YYYY-MM-DD' (the date the tool was first deployed/committed).
TOOL_ADDED_DATES = {
    'metabolic_model': '2026-03-23',
    'sigma':           '2026-04-16',
}

_cache      = {}
_cache_time = None


def get_updated_tools():
    """Return dict {tool_key: 'YYYY-MM-DD' | None} for recently updated tools.

    Value is the formatted commit date string when the last commit is within
    BADGE_DAYS, otherwise None (badge hidden).
    Results are cached for CACHE_TTL to avoid hammering the GitHub API.
    On any network or API error the tool key maps to None (badge hidden).
    """
    global _cache, _cache_time
    now = datetime.now(timezone.utc)
    if _cache_time and (now - _cache_time) < _CACHE_TTL:
        return _cache

    result  = {}
    cutoff  = now - timedelta(days=BADGE_DAYS)
    headers = {'Accept': 'application/vnd.github.v3+json'}

    for key, paths in TOOL_FILES.items():
        latest_dt = None
        for path in paths:
            try:
                params = urllib.parse.urlencode({'path': path, 'per_page': 1})
                url    = f"https://api.github.com/repos/{GITHUB_REPO}/commits?{params}"
                req    = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=4) as resp:
                    commits = json.loads(resp.read().decode())
                if commits:
                    date_str  = commits[0]['commit']['committer']['date']
                    commit_dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
                    if latest_dt is None or commit_dt > latest_dt:
                        latest_dt = commit_dt
            except Exception:
                pass
        if latest_dt and latest_dt > cutoff:
            result[key] = latest_dt.strftime('%Y-%m-%d')
        else:
            result[key] = None

    _cache      = result
    _cache_time = now
    return result


def get_new_tools():
    """Return dict {tool_key: True | None} for recently added tools.

    A tool is considered 'new' if its entry in TOOL_ADDED_DATES is within
    NEW_BADGE_DAYS of today.  Returns True when the badge should be shown,
    None (falsy) otherwise.  No network calls are made — purely date arithmetic.
    """
    now     = datetime.now(timezone.utc).date()
    cutoff  = now - timedelta(days=NEW_BADGE_DAYS)
    result  = {}
    for key, date_str in TOOL_ADDED_DATES.items():
        try:
            added = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
            result[key] = None
            continue
        result[key] = True if added >= cutoff else None
    return result
