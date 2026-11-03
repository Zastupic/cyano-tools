from flask import Blueprint, render_template
from . import limiter
from .shared import db
from .models import PageView
from sqlalchemy import func, and_, or_, case
from datetime import datetime, timedelta

settings = Blueprint('settings', __name__)

PAGE_NAMES = {
    '/':                          'Home',
    '/cell_count':                'Cell Count (Round)',
    '/cell_count_filament':       'Cell Count (Filament)',
    '/pixel_profiles_round_cells':'Pixel Profiles (Round)',
    '/pixel_profiles_filament':   'Pixel Profiles (Filament)',
    '/OJIP':                      'OJIP Data Analysis',
    '/NPQ':                       'Slow Kinetics Analysis',
    '/P700_kin_data_analysis':    'P700 Kinetics Analysis',
    '/EEM':                       'Ex/Em Spectra Analysis',
    '/cell_size_round_cells':     'Cell Size (Round)',
    '/cell_size_filament':        'Cell Size (Filament)',
    '/cell_morphology_filament':  'Cell Morphology (Filament)',
    '/RapidLightCurves':          'Light Curves Analysis',
    '/MIMS':                      'MIMS Data Analysis',
    '/MIMS_data_analysis_periodic':'MIMS Periodic Analysis',
    '/statistics':                'Statistics',
    '/calculators':               'Calculators',
    '/sigma':                     'Sigma(II) Analysis',
    '/PBR':                       'PBR Data Analysis',
    '/FBA':                       'Metabolic Model (FBA)',
}

@settings.route('/settings', methods=['GET', 'POST'])
def user_section_functions():
#    if current_user.is_authenticated:
    return render_template("settings.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")

COUNTRY_NAMES = {
    'AD': 'Andorra', 'AE': 'UAE', 'AF': 'Afghanistan', 'AG': 'Antigua & Barbuda',
    'AL': 'Albania', 'AM': 'Armenia', 'AO': 'Angola', 'AR': 'Argentina',
    'AT': 'Austria', 'AU': 'Australia', 'AZ': 'Azerbaijan', 'BA': 'Bosnia & Herz.',
    'BB': 'Barbados', 'BD': 'Bangladesh', 'BE': 'Belgium', 'BF': 'Burkina Faso',
    'BG': 'Bulgaria', 'BH': 'Bahrain', 'BI': 'Burundi', 'BJ': 'Benin',
    'BN': 'Brunei', 'BO': 'Bolivia', 'BR': 'Brazil', 'BS': 'Bahamas',
    'BT': 'Bhutan', 'BW': 'Botswana', 'BY': 'Belarus', 'BZ': 'Belize',
    'CA': 'Canada', 'CD': 'DR Congo', 'CF': 'Central African Rep.',
    'CG': 'Congo', 'CH': 'Switzerland', 'CI': "Cote d'Ivoire", 'CL': 'Chile',
    'CM': 'Cameroon', 'CN': 'China', 'CO': 'Colombia', 'CR': 'Costa Rica',
    'CU': 'Cuba', 'CV': 'Cape Verde', 'CY': 'Cyprus', 'CZ': 'Czechia',
    'DE': 'Germany', 'DJ': 'Djibouti', 'DK': 'Denmark', 'DM': 'Dominica',
    'DO': 'Dominican Rep.', 'DZ': 'Algeria', 'EC': 'Ecuador', 'EE': 'Estonia',
    'EG': 'Egypt', 'ER': 'Eritrea', 'ES': 'Spain', 'ET': 'Ethiopia',
    'FI': 'Finland', 'FJ': 'Fiji', 'FR': 'France', 'GA': 'Gabon',
    'GB': 'United Kingdom', 'GD': 'Grenada', 'GE': 'Georgia', 'GH': 'Ghana',
    'GM': 'Gambia', 'GN': 'Guinea', 'GQ': 'Equatorial Guinea', 'GR': 'Greece',
    'GT': 'Guatemala', 'GW': 'Guinea-Bissau', 'GY': 'Guyana', 'HK': 'Hong Kong',
    'HN': 'Honduras', 'HR': 'Croatia', 'HT': 'Haiti', 'HU': 'Hungary',
    'ID': 'Indonesia', 'IE': 'Ireland', 'IL': 'Israel', 'IN': 'India',
    'IQ': 'Iraq', 'IR': 'Iran', 'IS': 'Iceland', 'IT': 'Italy',
    'JM': 'Jamaica', 'JO': 'Jordan', 'JP': 'Japan', 'KE': 'Kenya',
    'KG': 'Kyrgyzstan', 'KH': 'Cambodia', 'KI': 'Kiribati', 'KM': 'Comoros',
    'KN': 'St Kitts & Nevis', 'KP': 'North Korea', 'KR': 'South Korea',
    'KW': 'Kuwait', 'KZ': 'Kazakhstan', 'LA': 'Laos', 'LB': 'Lebanon',
    'LC': 'St Lucia', 'LI': 'Liechtenstein', 'LK': 'Sri Lanka', 'LR': 'Liberia',
    'LS': 'Lesotho', 'LT': 'Lithuania', 'LU': 'Luxembourg', 'LV': 'Latvia',
    'LY': 'Libya', 'MA': 'Morocco', 'MC': 'Monaco', 'MD': 'Moldova',
    'ME': 'Montenegro', 'MG': 'Madagascar', 'MK': 'North Macedonia',
    'ML': 'Mali', 'MM': 'Myanmar', 'MN': 'Mongolia', 'MO': 'Macao',
    'MR': 'Mauritania', 'MT': 'Malta', 'MU': 'Mauritius', 'MV': 'Maldives',
    'MW': 'Malawi', 'MX': 'Mexico', 'MY': 'Malaysia', 'MZ': 'Mozambique',
    'NA': 'Namibia', 'NE': 'Niger', 'NG': 'Nigeria', 'NI': 'Nicaragua',
    'NL': 'Netherlands', 'NO': 'Norway', 'NP': 'Nepal', 'NR': 'Nauru',
    'NZ': 'New Zealand', 'OM': 'Oman', 'PA': 'Panama', 'PE': 'Peru',
    'PG': 'Papua New Guinea', 'PH': 'Philippines', 'PK': 'Pakistan',
    'PL': 'Poland', 'PT': 'Portugal', 'PY': 'Paraguay', 'QA': 'Qatar',
    'RO': 'Romania', 'RS': 'Serbia', 'RU': 'Russia', 'RW': 'Rwanda',
    'SA': 'Saudi Arabia', 'SB': 'Solomon Islands', 'SC': 'Seychelles',
    'SD': 'Sudan', 'SE': 'Sweden', 'SG': 'Singapore', 'SI': 'Slovenia',
    'SK': 'Slovakia', 'SL': 'Sierra Leone', 'SM': 'San Marino', 'SN': 'Senegal',
    'SO': 'Somalia', 'SR': 'Suriname', 'SS': 'South Sudan', 'SV': 'El Salvador',
    'SY': 'Syria', 'SZ': 'Eswatini', 'TD': 'Chad', 'TG': 'Togo',
    'TH': 'Thailand', 'TJ': 'Tajikistan', 'TL': 'Timor-Leste', 'TM': 'Turkmenistan',
    'TN': 'Tunisia', 'TO': 'Tonga', 'TR': 'Turkey', 'TT': 'Trinidad & Tobago',
    'TV': 'Tuvalu', 'TW': 'Taiwan', 'TZ': 'Tanzania', 'UA': 'Ukraine',
    'UG': 'Uganda', 'US': 'United States', 'UY': 'Uruguay', 'UZ': 'Uzbekistan',
    'VA': 'Vatican City', 'VC': 'St Vincent', 'VE': 'Venezuela', 'VN': 'Vietnam',
    'VU': 'Vanuatu', 'WS': 'Samoa', 'YE': 'Yemen', 'ZA': 'South Africa',
    'ZM': 'Zambia', 'ZW': 'Zimbabwe',
}


def _top_grouped(column, base_filter, since, limit=15):
    """Return top values for *column* grouped by count, filtered since *since*."""
    return db.session.query(
        column,
        func.count(PageView.id).label('count')
    ).filter(base_filter, PageView.timestamp >= since) \
     .group_by(column) \
     .order_by(func.count(PageView.id).desc()) \
     .limit(limit).all()


def _fmt_duration(seconds):
    """Format seconds as 'Xm Ys' or 'Xh Ym' for display."""
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    h = seconds // 3600
    m = (seconds % 3600) // 60
    return f"{h}h {m}m"


def _engagement_stats(human_filter, since):
    """Compute engagement metrics for visitors since *since*.

    Returns dict with keys: total_visitors, avg_pages, avg_session_secs,
    avg_session_fmt, engaged_count, engaged_pct, dist_1, dist_2_3, dist_4plus.

    Because ip_hash uses a daily salt, session correlation is only
    meaningful within a single UTC day.  For multi-day windows we still
    GROUP BY ip_hash, but the same real person on different days appears
    as different hashes — so these are "visitor-days", not unique people.

    Session duration uses LAG() to sum only inter-page gaps ≤ 5 min.
    Longer gaps indicate the user left and came back (separate session).
    5 min suits this app's typical workflow: open tool → upload → analyze
    → download (real browsing gaps are under 2-3 min).
    """
    max_gap = 300  # seconds — gaps longer than this start a new session

    # CTE: attach previous timestamp via LAG window function
    base = db.session.query(
        PageView.ip_hash,
        PageView.path,
        PageView.js_verified,
        PageView.timestamp,
        func.lag(PageView.timestamp).over(
            partition_by=PageView.ip_hash,
            order_by=PageView.timestamp,
        ).label('prev_ts'),
    ).filter(
        human_filter,
        PageView.timestamp >= since,
        PageView.ip_hash != None,  # noqa: E711
    ).cte('base')

    # Gap in seconds between consecutive page views (NULL for first view)
    gap_secs = (func.julianday(base.c.timestamp)
                - func.julianday(base.c.prev_ts)) * 86400

    # Per-visitor aggregates: pages, active session time, JS flag
    sub = db.session.query(
        base.c.ip_hash,
        func.count(func.distinct(base.c.path)).label('pages'),
        func.coalesce(
            func.sum(case((gap_secs <= max_gap, gap_secs), else_=0)),
            0,
        ).label('session_secs'),
        func.max(base.c.js_verified).label('any_js'),
    ).group_by(base.c.ip_hash).subquery()

    # Main query: aggregate distribution
    row = db.session.query(
        func.count().label('total'),
        func.coalesce(func.avg(sub.c.pages), 0).label('avg_pages'),
        func.coalesce(func.avg(sub.c.session_secs), 0).label('avg_session'),
        func.sum(case((sub.c.pages == 1, 1), else_=0)).label('dist_1'),
        func.sum(case((sub.c.pages.between(2, 3), 1), else_=0)).label('dist_2_3'),
        func.sum(case((sub.c.pages >= 4, 1), else_=0)).label('dist_4plus'),
        func.sum(case(
            (or_(sub.c.pages >= 2, sub.c.any_js == 1), 1),
            else_=0
        )).label('engaged'),
    ).select_from(sub).one()

    total = row.total or 0
    engaged = row.engaged or 0
    avg_secs = int(row.avg_session or 0)
    return {
        'total_visitors': total,
        'avg_pages': round(float(row.avg_pages or 0), 1),
        'avg_session_secs': avg_secs,
        'avg_session_fmt': _fmt_duration(avg_secs),
        'engaged_count': engaged,
        'engaged_pct': round(100 * engaged / total, 1) if total else 0,
        'dist_1': row.dist_1 or 0,
        'dist_2_3': row.dist_2_3 or 0,
        'dist_4plus': row.dist_4plus or 0,
    }


@settings.route('/site_stats')
@limiter.limit("30 per minute")
def site_stats():
    now = datetime.utcnow()
    # Base filters
    not_stats = PageView.path != '/site_stats'
    human_filter = and_(not_stats, or_(PageView.is_bot == False, PageView.is_bot == None))  # noqa: E711,E712
    bot_filter = and_(not_stats, PageView.is_bot == True)  # noqa: E712

    base_q = PageView.query.filter(human_filter)

    # ── Standard time windows ─────────────────────────────────────────────
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    since_7d  = now - timedelta(days=7)
    since_30d = now - timedelta(days=30)
    since_yr  = now - timedelta(days=365)
    windows = {
        'today': today_start,
        '7d':    since_7d,
        '30d':   since_30d,
        'year':  since_yr,
    }

    # ── Summary cards ─────────────────────────────────────────────────────
    today_count = base_q.filter(PageView.timestamp >= today_start).count()
    week_count  = base_q.filter(PageView.timestamp >= since_7d).count()
    month_count = base_q.filter(PageView.timestamp >= since_30d).count()
    year_count  = base_q.filter(PageView.timestamp >= since_yr).count()

    unique_today = db.session.query(func.count(func.distinct(PageView.ip_hash))) \
                             .filter(human_filter,
                                     PageView.timestamp >= today_start).scalar() or 0

    # JS-verified percentage (last 30 days, humans only)
    human_30d = base_q.filter(PageView.timestamp >= since_30d)
    js_verified_count = human_30d.filter(PageView.js_verified == True).count()  # noqa: E712
    js_verified_pct = round(100 * js_verified_count / month_count, 1) if month_count else 0

    # ── Top pages (all windows) ───────────────────────────────────────────
    page_filter = and_(human_filter, PageView.path.in_(list(PAGE_NAMES.keys())))
    top_pages = {}
    for w, since in windows.items():
        raw = _top_grouped(PageView.path, page_filter, since)
        top_pages[w] = [
            {'path': r.path, 'name': PAGE_NAMES.get(r.path, r.path), 'count': r.count}
            for r in raw
        ]

    # ── Traffic sources (all windows) ─────────────────────────────────────
    src_filter = and_(human_filter, PageView.source != None)  # noqa: E711
    top_sources = {}
    for w, since in windows.items():
        raw = _top_grouped(PageView.source, src_filter, since, limit=10)
        top_sources[w] = [{'source': r.source, 'count': r.count} for r in raw]

    # ── Geography (all windows) ───────────────────────────────────────────
    geo_filter = and_(human_filter, PageView.country_code != None)  # noqa: E711
    top_countries = {}
    for w, since in windows.items():
        raw = _top_grouped(PageView.country_code, geo_filter, since, limit=20)
        top_countries[w] = [
            {'code': r.country_code, 'name': COUNTRY_NAMES.get(r.country_code, r.country_code), 'count': r.count}
            for r in raw
        ]

    # ── Bot traffic stats ─────────────────────────────────────────────────
    bot_total = PageView.query.filter(bot_filter).count()
    bot_counts = {}
    for w, since in windows.items():
        bot_counts[w] = PageView.query.filter(bot_filter, PageView.timestamp >= since).count()

    # Top bot User-Agents (all windows)
    ua_filter = and_(bot_filter, PageView.user_agent != None)  # noqa: E711
    top_bots = {}
    for w, since in windows.items():
        raw = _top_grouped(PageView.user_agent, ua_filter, since, limit=15)
        top_bots[w] = [{'ua': r.user_agent[:120], 'count': r.count} for r in raw]

    # ── Engagement metrics (all windows) ─────────────────────────────────
    engagement = {}
    for w, since in windows.items():
        engagement[w] = _engagement_stats(human_filter, since)

    # ── Time-series charts (unchanged) ────────────────────────────────────

    # --- Last hour by minute (dense, zero-filled) ---
    hour_ago = now - timedelta(hours=1)
    raw = db.session.query(
        func.strftime('%Y-%m-%d %H:%M', PageView.timestamp).label('slot'),
        func.count(PageView.id).label('count')
    ).filter(human_filter, PageView.timestamp >= hour_ago) \
     .group_by('slot').order_by('slot').all()
    hr_map = {r.slot: r.count for r in raw}
    hour_labels, hour_counts = [], []
    for i in range(61):
        t = hour_ago + timedelta(minutes=i)
        hour_labels.append(t.strftime('%H:%M'))
        hour_counts.append(hr_map.get(t.strftime('%Y-%m-%d %H:%M'), 0))

    # --- Last 24 hours by hour (dense, zero-filled) ---
    day_ago = now - timedelta(hours=24)
    raw = db.session.query(
        func.strftime('%Y-%m-%d %H', PageView.timestamp).label('slot'),
        func.count(PageView.id).label('count')
    ).filter(human_filter, PageView.timestamp >= day_ago) \
     .group_by('slot').order_by('slot').all()
    d24_map = {r.slot: r.count for r in raw}
    day24_labels, day24_counts = [], []
    for i in range(25):
        t = day_ago + timedelta(hours=i)
        key = t.strftime('%Y-%m-%d %H')
        day24_labels.append(t.strftime('%a %H:00'))
        day24_counts.append(d24_map.get(key, 0))

    # --- Last 30 days by day (dense, zero-filled) ---
    raw = db.session.query(
        func.strftime('%Y-%m-%d', PageView.timestamp).label('slot'),
        func.count(PageView.id).label('count')
    ).filter(human_filter, PageView.timestamp >= since_30d) \
     .group_by('slot').order_by('slot').all()
    d30_map = {r.slot: r.count for r in raw}
    d30_labels, d30_counts = [], []
    for i in range(31):
        t = since_30d + timedelta(days=i)
        key = t.strftime('%Y-%m-%d')
        d30_labels.append(key[5:])  # MM-DD
        d30_counts.append(d30_map.get(key, 0))

    # --- Last 12 months by calendar month (dense, zero-filled) ---
    raw = db.session.query(
        func.strftime('%Y-%m', PageView.timestamp).label('slot'),
        func.count(PageView.id).label('count')
    ).filter(human_filter, PageView.timestamp >= since_yr) \
     .group_by('slot').order_by('slot').all()
    yr_map = {r.slot: r.count for r in raw}
    yr_labels, yr_counts = [], []
    for i in range(11, -1, -1):
        m, y = now.month - i, now.year
        while m <= 0:
            m += 12
            y -= 1
        key = f"{y:04d}-{m:02d}"
        yr_labels.append(datetime(y, m, 1).strftime('%b %Y'))
        yr_counts.append(yr_map.get(key, 0))

    # ── Peak traffic heatmap (last 30 days, hour × day-of-week) ───────────
    raw = db.session.query(
        func.strftime('%w', PageView.timestamp).label('dow'),   # 0=Sun
        func.strftime('%H', PageView.timestamp).label('hour'),
        func.count(PageView.id).label('count')
    ).filter(human_filter, PageView.timestamp >= since_30d) \
     .group_by('dow', 'hour').all()
    # Build 7×24 grid (Mon=0 … Sun=6)
    heatmap = [[0] * 24 for _ in range(7)]
    for r in raw:
        # SQLite %w: 0=Sun,1=Mon…6=Sat → remap to Mon=0…Sun=6
        sqlite_dow = int(r.dow)
        day_idx = (sqlite_dow - 1) % 7
        heatmap[day_idx][int(r.hour)] = r.count

    # ── GeoIP database info ──────────────────────────────────────────────
    from . import _get_geoip_info
    geoip_info = _get_geoip_info()

    return render_template('site_stats.html',
        today_count  = today_count,
        week_count   = week_count,
        month_count  = month_count,
        year_count   = year_count,
        unique_today = unique_today,
        js_verified_pct = js_verified_pct,
        top_pages    = top_pages,
        top_sources  = top_sources,
        top_countries = top_countries,
        hour_labels  = hour_labels,
        hour_counts  = hour_counts,
        day24_labels = day24_labels,
        day24_counts = day24_counts,
        d30_labels   = d30_labels,
        d30_counts   = d30_counts,
        yr_labels    = yr_labels,
        yr_counts    = yr_counts,
        bot_total    = bot_total,
        bot_counts   = bot_counts,
        top_bots     = top_bots,
        heatmap      = heatmap,
        engagement   = engagement,
        geoip_info   = geoip_info,
    )
