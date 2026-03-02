"""
Fetches last-commit dates per tool file from GitHub and caches results for 6 hours.
Used to drive the 'Updated' badge on the home page.
"""
import urllib.request
import urllib.parse
import json
from datetime import datetime, timedelta, timezone

GITHUB_REPO = "Zastupic/tools-py.e-cyanobacterium.org"
BADGE_DAYS  = 60   # badge visible this many days after the last commit to the tool file
_CACHE_TTL  = timedelta(hours=6)

# Map home-page tile key → path of the tool's main Python file in the repo
TOOL_FILES = {
    'light_curves':            'website/light_curves_analysis.py',
    'ojip':                    'website/OJIP_data_analysis.py',
    'slow_kin':                'website/slow_kin_data_analysis.py',
    'ex_em':                   'website/ex_em_spectra_analysis.py',
    'mims':                    'website/MIMS_data_analysis.py',
    'statistics':              'website/statistics.py',
    'calculators':             'website/calculators.py',
    'cell_count':              'website/cell_count.py',
    'cell_count_filament':     'website/cell_count_filament.py',
    'cell_size':               'website/cell_size_round_cells.py',
    'cell_size_filament':      'website/cell_size_filament.py',
    'pixel_profiles':          'website/pixel_profiles_round_cells.py',
    'pixel_profiles_filament': 'website/pixel_profiles_filament.py',
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

    for key, path in TOOL_FILES.items():
        try:
            params = urllib.parse.urlencode({'path': path, 'per_page': 1})
            url    = f"https://api.github.com/repos/{GITHUB_REPO}/commits?{params}"
            req    = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=4) as resp:
                commits = json.loads(resp.read().decode())
            if commits:
                date_str  = commits[0]['commit']['committer']['date']
                commit_dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
                result[key] = commit_dt.strftime('%Y-%m-%d') if commit_dt > cutoff else None
            else:
                result[key] = None
        except Exception:
            result[key] = None

    _cache      = result
    _cache_time = now
    return result
