from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user
from .shared import db
from .models import PageView
from sqlalchemy import func
from datetime import datetime, timedelta

settings = Blueprint('settings', __name__)

@settings.route('/settings', methods=['GET', 'POST'])
def user_section_functions():
#    if current_user.is_authenticated:
    return render_template("settings.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")

@settings.route('/site_stats')
def site_stats():
    total = PageView.query.count()

    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_count  = PageView.query.filter(PageView.timestamp >= today_start).count()
    unique_today = db.session.query(func.count(func.distinct(PageView.ip_hash))) \
                             .filter(PageView.timestamp >= today_start).scalar() or 0

    since = datetime.utcnow() - timedelta(days=30)
    month_count = PageView.query.filter(PageView.timestamp >= since).count()

    top_pages = db.session.query(
        PageView.path,
        func.count(PageView.id).label('count')
    ).filter(PageView.timestamp >= since) \
     .group_by(PageView.path) \
     .order_by(func.count(PageView.id).desc()) \
     .limit(20).all()

    daily_raw = db.session.query(
        func.strftime('%Y-%m-%d', PageView.timestamp).label('day'),
        func.count(PageView.id).label('count')
    ).filter(PageView.timestamp >= since) \
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