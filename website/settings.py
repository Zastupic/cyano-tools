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
    base_q = PageView.query.filter(PageView.path != '/site_stats')

    total = base_q.count()

    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_count  = base_q.filter(PageView.timestamp >= today_start).count()
    unique_today = db.session.query(func.count(func.distinct(PageView.ip_hash))) \
                             .filter(PageView.timestamp >= today_start,
                                     PageView.path != '/site_stats').scalar() or 0

    since = datetime.utcnow() - timedelta(days=30)
    month_count = base_q.filter(PageView.timestamp >= since).count()

    top_pages_raw = db.session.query(
        PageView.path,
        func.count(PageView.id).label('count')
    ).filter(PageView.timestamp >= since,
             PageView.path.in_(list(PAGE_NAMES.keys()))) \
     .group_by(PageView.path) \
     .order_by(func.count(PageView.id).desc()) \
     .all()

    top_pages = [
        {'path': r.path, 'name': PAGE_NAMES.get(r.path, r.path), 'count': r.count}
        for r in top_pages_raw
    ]

    daily_raw = db.session.query(
        func.strftime('%Y-%m-%d', PageView.timestamp).label('day'),
        func.count(PageView.id).label('count')
    ).filter(PageView.timestamp >= since,
             PageView.path != '/site_stats') \
     .group_by('day').order_by('day').all()

    return render_template('site_stats.html',
        total        = total,
        today_count  = today_count,
        unique_today = unique_today,
        month_count  = month_count,
        top_pages    = top_pages,
        daily_labels = [r.day   for r in daily_raw],
        daily_counts = [r.count for r in daily_raw],
    )