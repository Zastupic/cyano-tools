from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER, limiter
from flask_login import current_user, login_required
from .shared import db
from .models import PageView
from sqlalchemy import func, and_, or_
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

@settings.route('/site_stats')
@limiter.limit("30 per minute")
def site_stats():
    now = datetime.utcnow()
    # Base query excludes /site_stats and bots (for human stats)
    not_stats = PageView.path != '/site_stats'
    human_filter = and_(not_stats, or_(PageView.is_bot == False, PageView.is_bot == None))  # noqa: E711,E712

    base_q = PageView.query.filter(human_filter)

    total = base_q.count()

    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_count  = base_q.filter(PageView.timestamp >= today_start).count()
    unique_today = db.session.query(func.count(func.distinct(PageView.ip_hash))) \
                             .filter(human_filter,
                                     PageView.timestamp >= today_start).scalar() or 0

    since_30d = now - timedelta(days=30)
    month_count = base_q.filter(PageView.timestamp >= since_30d).count()

    # JS-verified percentage (last 30 days, humans only)
    human_30d = base_q.filter(PageView.timestamp >= since_30d)
    js_verified_count = human_30d.filter(PageView.js_verified == True).count()  # noqa: E712
    js_verified_pct = round(100 * js_verified_count / month_count, 1) if month_count else 0

    top_pages_raw = db.session.query(
        PageView.path,
        func.count(PageView.id).label('count')
    ).filter(human_filter,
             PageView.timestamp >= since_30d,
             PageView.path.in_(list(PAGE_NAMES.keys()))) \
     .group_by(PageView.path) \
     .order_by(func.count(PageView.id).desc()) \
     .all()

    top_pages = [
        {'path': r.path, 'name': PAGE_NAMES.get(r.path, r.path), 'count': r.count}
        for r in top_pages_raw
    ]

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
    year_ago = now - timedelta(days=365)
    raw = db.session.query(
        func.strftime('%Y-%m', PageView.timestamp).label('slot'),
        func.count(PageView.id).label('count')
    ).filter(human_filter, PageView.timestamp >= year_ago) \
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

    # ── Bot traffic stats ─────────────────────────────────────────────────
    bot_filter = and_(not_stats, PageView.is_bot == True)  # noqa: E712
    bot_total    = PageView.query.filter(bot_filter).count()
    bot_today    = PageView.query.filter(bot_filter, PageView.timestamp >= today_start).count()
    bot_30d      = PageView.query.filter(bot_filter, PageView.timestamp >= since_30d).count()

    # Top bot User-Agents (last 30 days)
    top_bots_raw = db.session.query(
        PageView.user_agent,
        func.count(PageView.id).label('count')
    ).filter(bot_filter, PageView.timestamp >= since_30d,
             PageView.user_agent != None) \
     .group_by(PageView.user_agent) \
     .order_by(func.count(PageView.id).desc()) \
     .limit(15).all()
    top_bots = [{'ua': r.user_agent[:120], 'count': r.count} for r in top_bots_raw]

    # ── Traffic sources (last 30 days, humans only) ───────────────────────
    sources_raw = db.session.query(
        PageView.source,
        func.count(PageView.id).label('count')
    ).filter(human_filter, PageView.timestamp >= since_30d,
             PageView.source != None) \
     .group_by(PageView.source) \
     .order_by(func.count(PageView.id).desc()) \
     .limit(10).all()
    top_sources = [{'source': r.source, 'count': r.count} for r in sources_raw]

    return render_template('site_stats.html',
        total        = total,
        today_count  = today_count,
        unique_today = unique_today,
        month_count  = month_count,
        js_verified_pct = js_verified_pct,
        top_pages    = top_pages,
        hour_labels  = hour_labels,
        hour_counts  = hour_counts,
        day24_labels = day24_labels,
        day24_counts = day24_counts,
        d30_labels   = d30_labels,
        d30_counts   = d30_counts,
        yr_labels    = yr_labels,
        yr_counts    = yr_counts,
        bot_total    = bot_total,
        bot_today    = bot_today,
        bot_30d      = bot_30d,
        top_bots     = top_bots,
        top_sources  = top_sources,
    )
