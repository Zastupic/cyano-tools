from flask import Flask, request, redirect
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from flask_uploads import IMAGES, UploadSet, configure_uploads
from .shared import db
from os import path
import hashlib
from datetime import datetime
import os, glob, time, threading

DB_NAME = "database.db"
UPLOAD_FOLDER = 'website/static/uploads/'
ALLOWED_EXTENSIONS = set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif'])

images = UploadSet('images', IMAGES)


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
    app.config['SECRET_KEY'] = 'TotallySecretKey' 
    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{DB_NAME}' 
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS']=False
    
    # Konfigurace session cookies
    app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100 MB — allow large OJIP batch uploads
    app.config['SESSION_COOKIE_SAMESITE'] = 'None'    # Použijte 'None' pro třetí strany, 'Strict' pro silné omezení
    app.config['SESSION_COOKIE_SECURE'] = True       # Pouze pro HTTPS
    app.config['SESSION_COOKIE_HTTPONLY'] = True     # Zabrání přístupu JavaScriptem

    db.init_app(app)

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

    @app.before_request
    def redirect_unknown_subdomains():
        host = request.host.split(':')[0]
        if host in ('localhost', '127.0.0.1'):
            return
        if host not in ALLOWED_HOSTS:
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
    from .OJIP_data_analysis import OJIP_data_analysis
    from .slow_kin_data_analysis import slow_kin_data_analysis
    from .P700_kin_data_analysis import P700_kin_data_analysis
    from .ex_em_spectra_analysis import ex_em_spectra_analysis
    from .cell_size_round_cells import cell_size_round_cells
    from .cell_size_filament import cell_size_filament
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
        from . import metanetx_lookup
        if not metanetx_lookup.files_available():
            _start_metanetx_download()

    return app

def create_database(app):
    if not path.exists('website/' + DB_NAME):
        db.create_all(app) #WORKING VERSION: db.create_all(app=app)
        print('Created Database!')