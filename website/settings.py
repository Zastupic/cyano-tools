from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user
from .shared import db
from .models import PageView
from sqlalchemy import func
from datetime import datetime, timedelta

settings = Blueprint('settings', __name__)

PAGE_NAMES = {
    '/':                          'Home',
    '/cell_count':                'Cell Count (Round)',
    '/cell_count_filament':       'Cell Count (Filament)',
    '/pixel_profiles_round_cells':'Pixel Profiles (Round)',
    '/pixel_profiles_filament':   'Pixel Profiles (Filament)',
    '/OJIP_data_analysis':        'OJIP Data Analysis',
    '/slow_kin_data_analysis':    'Slow Kinetics Analysis',
    '/P700_kin_data_analysis':    'P700 Kinetics Analysis',
    '/ex_em_spectra_analysis':    'Ex/Em Spectra Analysis',
    '/cell_size_round_cells':     'Cell Size (Round)',
    '/cell_size_filament':        'Cell Size (Filament)',
    '/light_curves_analysis':     'Light Curves Analysis',
    '/MIMS_data_analysis':        'MIMS Data Analysis',
    '/MIMS_data_analysis_periodic':'MIMS Periodic Analysis',
    '/statistics':                'Statistics',
    '/calculators':               'Calculators',
    '/development_log':           'Development Log',
}

@settings.route('/settings', methods=['GET', 'POST'])
def user_section_functions():
#    if current_user.is_authenticated:
    return render_template("settings.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")

@settings.route('/site_stats')
def site_stats():
    now = datetime.utcnow()
    base_q = PageView.query.filter(PageView.path != '/site_stats')

    total = base_q.count()

    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_count  = base_q.filter(PageView.timestamp >= today_start).count()
    unique_today = db.session.query(func.count(func.distinct(PageView.ip_hash))) \
                             .filter(PageView.timestamp >= today_start,
                                     PageView.path != '/site_stats').scalar() or 0

    since_30d = now - timedelta(days=30)
    month_count = base_q.filter(PageView.timestamp >= since_30d).count()

    top_pages_raw = db.session.query(
        PageView.path,
        func.count(PageView.id).label('count')
    ).filter(PageView.timestamp >= since_30d,
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
    ).filter(PageView.timestamp >= hour_ago, PageView.path != '/site_stats') \
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
    ).filter(PageView.timestamp >= day_ago, PageView.path != '/site_stats') \
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
    ).filter(PageView.timestamp >= since_30d, PageView.path != '/site_stats') \
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
    ).filter(PageView.timestamp >= year_ago, PageView.path != '/site_stats') \
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

    return render_template('site_stats.html',
        total        = total,
        today_count  = today_count,
        unique_today = unique_today,
        month_count  = month_count,
        top_pages    = top_pages,
        hour_labels  = hour_labels,
        hour_counts  = hour_counts,
        day24_labels = day24_labels,
        day24_counts = day24_counts,
        d30_labels   = d30_labels,
        d30_counts   = d30_counts,
        yr_labels    = yr_labels,
        yr_counts    = yr_counts,
    )