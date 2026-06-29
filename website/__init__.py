from flask import Flask, request, redirect
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from flask_uploads import IMAGES, UploadSet, configure_uploads
from flask_wtf.csrf import CSRFProtect
from .shared import db
from os import path
import hashlib
from datetime import datetime
import os, glob, time, threading, re
# Flask-Limiter: install with  pip install Flask-Limiter
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

DB_NAME = "database.db"
UPLOAD_FOLDER = 'website/static/uploads/'
ALLOWED_EXTENSIONS = set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif'])

images = UploadSet('images', IMAGES)

# ── Rate limiter (module-level so blueprints can import and decorate with it) ─
limiter = Limiter(key_func=get_remote_address, default_limits=["200 per minute", "2000 per hour"])

# ── CSRF protection (module-level so blueprints can import csrf.exempt) ───────
csrf = CSRFProtect()

# ── Cache-key validator — prevents path-traversal via cached_image_key ────────
_SAFE_KEY_RE = re.compile(
    r'^[a-zA-Z0-9_-]{1,220}\.(png|jpg|jpeg|tif|tiff|bmp|gif)$',
    re.IGNORECASE,
)

def safe_cache_key(key: str) -> 'str | None':
    """Return key if it is a safe upload-folder filename, else None.

    Rejects anything that contains path separators, '..' sequences, or
    characters outside the expected UUID/alphanumeric set so that a
    malicious cached_image_key cannot traverse outside UPLOAD_FOLDER.
    """
    key = key.strip()
    if not _SAFE_KEY_RE.match(key):
        return None
    # Belt-and-suspenders: verify the resolved path stays inside the upload dir
    upload_abs = os.path.abspath(UPLOAD_FOLDER)
    resolved   = os.path.abspath(os.path.join(UPLOAD_FOLDER, key))
    if not resolved.startswith(upload_abs + os.sep):
        return None
    return key

def _ensure_opencv_js():
    """Download opencv.js to static folder if not already present (runs in background thread)."""
    import urllib.request
    import ssl
    dest = os.path.join(os.path.dirname(__file__), 'static', 'opencv.js')
    if os.path.exists(dest):
        return
    url = 'https://docs.opencv.org/4.8.0/opencv.js'
    print('[opencv] Downloading opencv.js (~8 MB), live cell count will be available shortly…')
    try:
        ctx = ssl.create_default_context()
        try:
            urllib.request.urlretrieve(url, dest)
        except Exception:
            # Fallback: skip SSL verification (matches pip --trusted-host behaviour)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, context=ctx, timeout=120) as r, open(dest, 'wb') as f:
                f.write(r.read())
        print('[opencv] opencv.js downloaded successfully.')
    except Exception as exc:
        print(f'[opencv] Failed to download opencv.js: {exc}')


def _start_metanetx_download():
    """Background thread: download MetaNetX TSV files if not already present."""
    import importlib
    def _run():
        try:
            mnx = importlib.import_module('website.metanetx_lookup')
            dl  = importlib.import_module('website.download_metanetx')
            if mnx.files_available():
                mnx.set_download_state('ready')
                return
            mnx.set_download_state('downloading')
            dl.main()
            mnx.set_download_state('ready' if mnx.files_available() else 'failed')
        except Exception as exc:
            print(f'[metanetx] Auto-download failed: {exc}')
            try:
                mnx = importlib.import_module('website.metanetx_lookup')
                mnx.set_download_state('failed')
            except Exception:
                pass
    t = threading.Thread(target=_run, daemon=True)
    t.start()


def _start_upload_cleanup(folder, max_age_minutes=30, interval_hours=1):
    """Daemon thread: every interval_hours, delete files in folder older than max_age_minutes."""
    def _loop():
        while True:
            time.sleep(interval_hours * 3600)
            cutoff = time.time() - max_age_minutes * 60
            for path_ in glob.glob(os.path.join(folder, '*')):
                try:
                    if os.path.isfile(path_) and os.path.getmtime(path_) < cutoff:
                        os.remove(path_)
                except OSError:
                    pass

    t = threading.Thread(target=_loop, daemon=True)
    t.start()


def create_app():
    app = Flask(__name__)
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)
    app.config['UPLOADED_IMAGES_DEST'] = UPLOAD_FOLDER # if UploadSet ("invoices", INVOICES) --> app.config[UPLOADED_INVOICES_DEST]
    _secret_key = os.environ.get('SECRET_KEY')
    if not _secret_key:
        raise RuntimeError(
            "SECRET_KEY environment variable is not set. "
            "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    app.config['SECRET_KEY'] = _secret_key
    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{DB_NAME}'
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS']=False

    # Session cookie configuration
    app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100 MB — allow large OJIP batch uploads
    app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'    # Lax prevents cross-site POST (CSRF protection)
    app.config['SESSION_COOKIE_SECURE'] = not app.debug  # HTTPS only in production
    app.config['SESSION_COOKIE_HTTPONLY'] = True     # Not accessible from JavaScript
    # Remember-me cookie — same security flags as session cookie
    app.config['REMEMBER_COOKIE_SECURE'] = not app.debug
    app.config['REMEMBER_COOKIE_HTTPONLY'] = True
    app.config['REMEMBER_COOKIE_SAMESITE'] = 'Lax'

    db.init_app(app)
    limiter.init_app(app)
    csrf.init_app(app)

    from .views import views
    from .auth import auth
    from .cell_count import cell_count
    from .cell_count_filament import cell_count_filament
    from .pixel_profiles_round_cells import pixel_profiles_round_cells
    from .pixel_profiles_filament import pixel_profiles_filament
    from .models import User, PageView

    ALLOWED_HOSTS = frozenset([
        'www.cyano.tools',
        'webapp-30413.eu.pythonanywhere.com',
    ])

    OLD_DOMAIN = 'tools-py.e-cyanobacterium.org'

    @app.before_request
    def redirect_unknown_subdomains():
        host = request.host.split(':')[0]
        
        # 1. Allow internal/local traffic
        if host in ('localhost', '127.0.0.1') or host in ALLOWED_HOSTS:
            return

        # 2. Redirect the old domain (or any other unknown alias) to the new domain
        # This captures 'tools-py.e-cyanobacterium.org'
        target = 'https://www.cyano.tools' + request.full_path.rstrip('?')
        return redirect(target, 301)

    TRACKED_PATHS = frozenset([
        '/', '/cell_count', '/cell_count_filament',
        '/pixel_profiles_round_cells', '/pixel_profiles_filament',
        '/OJIP_data_analysis', '/slow_kin_data_analysis',
        '/P700_kin_data_analysis', '/ex_em_spectra_analysis',
        '/cell_size_round_cells', '/cell_size_filament',
        '/light_curves_analysis', '/MIMS_data_analysis',
        '/MIMS_data_analysis_periodic', '/statistics',
        '/calculators', '/sigma_analysis',
        '/pbr_analysis',
    ])

    @app.before_request
    def log_page_view():
        if request.path not in TRACKED_PATHS:
            return
        if request.method != 'GET':
            return
        ua = (request.headers.get('User-Agent') or '').lower()
        if not ua:
            return
        if any(b in ua for b in (
            'bot', 'crawler', 'spider', 'slurp', 'headless',
            'python-requests', 'python-urllib', 'python-httpx',
            'curl/', 'wget/', 'scrapy', 'httpie', 'insomnia', 'postmanruntime',
            'go-http-client', 'java/', 'libwww-perl',
            'okhttp', 'node-fetch',
            'facebookexternalhit', 'facebookcatalog',
            'ia_archiver', 'archive.org',
            'dataforseo', 'zgrab', 'masscan', 'censys', 'shodan',
            'nmap', 'nikto',
        )):
            return
        try:
            ip   = request.remote_addr or ''
            salt = datetime.utcnow().strftime('%Y-%m-%d')
            ip_hash = hashlib.sha256((ip + salt).encode()).hexdigest()[:16]
            ref = (request.referrer or '')[:500]
            db.session.add(PageView(
                timestamp = datetime.utcnow(), # type: ignore
                path      = request.path[:200], # type: ignore
                ip_hash   = ip_hash, # type: ignore
                referrer  = ref or None, # type: ignore
            ))
            db.session.commit()
        except Exception:
            db.session.rollback()

    @app.after_request
    def set_security_headers(response):
        # Long cache for opencv.js and cv_worker.js — large static files that never change
        if request.path in ('/static/opencv.js', '/static/cv_worker.js'):
            response.headers['Cache-Control'] = 'public, max-age=2592000, immutable'  # 30 days
        response.headers['X-Frame-Options'] = 'SAMEORIGIN'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
        # Only set HSTS on HTTPS responses to avoid breaking local HTTP dev
        if request.is_secure:
            response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
        # Content-Security-Policy — permissive but blocks inline event handlers from CDN compromise
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; "
            "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval' cdn.jsdelivr.net cdn.sheetjs.com "
            "ajax.googleapis.com maxcdn.bootstrapcdn.com cdn.plot.ly cdnjs.cloudflare.com "
            "docs.opencv.org www.googletagmanager.com www.google-analytics.com; "
            "worker-src blob: 'self'; "
            "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net stackpath.bootstrapcdn.com "
            "cdnjs.cloudflare.com; "
            "img-src 'self' data: blob: www.czechglobe.cz www.googletagmanager.com; "
            "connect-src 'self' data: blob: cdn.jsdelivr.net maxcdn.bootstrapcdn.com "
            "cdn.sheetjs.com cdnjs.cloudflare.com https://*.google-analytics.com https://*.analytics.google.com; "
            "font-src 'self' stackpath.bootstrapcdn.com cdnjs.cloudflare.com cdn.jsdelivr.net; "
            "frame-ancestors 'self';"
        )
        return response

    from .OJIP_data_analysis import OJIP_data_analysis
    from .slow_kin_data_analysis import slow_kin_data_analysis
    from .P700_kin_data_analysis import P700_kin_data_analysis
    from .ex_em_spectra_analysis import ex_em_spectra_analysis
    from .cell_size_round_cells import cell_size_round_cells
    from .cell_size_filament import cell_size_filament
    from .cell_morphology_filament import cell_morphology_filament
    from .settings import settings 
    from .light_curves_analysis import light_curves_analysis 
    from .calculators import calculators
    from .MIMS_data_analysis import MIMS_data_analysis
    from .MIMS_data_analysis_periodic import MIMS_data_analysis_periodic
    from .statistics import stats_bp
    from .deploy import deploy
    from .pixel_size_api import pixel_size_api
    from .metabolic_model import metabolic_bp
    from .sigma_analysis import sigma_bp
    from .pbr_analysis import pbr_analysis_bp

    app.register_blueprint(views, url_prefix='/')
    app.register_blueprint(auth, url_prefix='/')
    app.register_blueprint(cell_count, url_prefix='/')
    app.register_blueprint(cell_count_filament, url_prefix='/')
    app.register_blueprint(pixel_profiles_round_cells, url_prefix='/')
    app.register_blueprint(pixel_profiles_filament, url_prefix='/')
    app.register_blueprint(OJIP_data_analysis, url_prefix='/')
    app.register_blueprint(slow_kin_data_analysis, url_prefix='/')
    app.register_blueprint(P700_kin_data_analysis, url_prefix='/')
    app.register_blueprint(ex_em_spectra_analysis, url_prefix='/')
    app.register_blueprint(cell_size_round_cells, url_prefix='/')
    app.register_blueprint(cell_size_filament, url_prefix='/')
    app.register_blueprint(cell_morphology_filament, url_prefix='/')
    app.register_blueprint(settings, url_prefix='/') 
    app.register_blueprint(light_curves_analysis, url_prefix='/') 
    app.register_blueprint(calculators, url_prefix='/') 
    app.register_blueprint(MIMS_data_analysis, url_prefix='/')
    app.register_blueprint(MIMS_data_analysis_periodic, url_prefix='/')
    app.register_blueprint(stats_bp, url_prefix='/')
    app.register_blueprint(deploy, url_prefix='/')
    app.register_blueprint(pixel_size_api, url_prefix='/')
    app.register_blueprint(metabolic_bp, url_prefix='/')
    app.register_blueprint(sigma_bp, url_prefix='/')
    app.register_blueprint(pbr_analysis_bp, url_prefix='/')

    #### DATABASE ####
    with app.app_context(): # creating the database
        db.create_all()

    #### LOGIN MANAGAER ####
    login_manager = LoginManager()
    login_manager.login_view = 'auth.login' # type: ignore # where flask will redirect user when not logged in
    login_manager.init_app(app)
    login_manager.login_message = ''


    @login_manager.user_loader
    def load_user(id):
        return User.query.get(int(id))

    #### UPLOADING IMAGE ####
    configure_uploads(app, images)

    # Start background cleanup only in the real worker process, not in the
    # Werkzeug reloader watcher (which would otherwise start two threads).
    if not app.debug or os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        _start_upload_cleanup(UPLOAD_FOLDER, max_age_minutes=30, interval_hours=2)
        threading.Thread(target=_ensure_opencv_js, daemon=True).start()
        from . import metanetx_lookup
        if not metanetx_lookup.files_available():
            _start_metanetx_download()

    return app

def create_database(app):
    if not path.exists('website/' + DB_NAME):
        db.create_all(app) #WORKING VERSION: db.create_all(app=app)
        print('Created Database!')