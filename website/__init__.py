from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from flask_uploads import IMAGES, UploadSet, configure_uploads
from .shared import db
from os import path

DB_NAME = "database.db"
UPLOAD_FOLDER = 'website/static/uploads/'
ALLOWED_EXTENSIONS = set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif'])

images = UploadSet('images', IMAGES)

def create_app():
    app = Flask(__name__)
    app.config['UPLOADED_IMAGES_DEST'] = UPLOAD_FOLDER # if UploadSet ("invoices", INVOICES) --> app.config[UPLOADED_INVOICES_DEST]
    app.config['SECRET_KEY'] = 'TotallySecretKey' 
    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{DB_NAME}' 
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS']=False
    
    # Konfigurace session cookies
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
    from .models import User
    from .OJIP_data_analysis import OJIP_data_analysis
    from .slow_kin_data_analysis import slow_kin_data_analysis
    from .P700_kin_data_analysis import P700_kin_data_analysis
    from .ex_em_spectra_analysis import ex_em_spectra_analysis
    from .cell_size_round_cells import cell_size_round_cells
    from .cell_size_filament import cell_size_filament
    from .settings import settings 
    from .light_curves_analysis import light_curves_analysis 
    from .calculators import calculators
    from .development_log import development_log
    from .MIMS_data_analysis import MIMS_data_analysis
    from .MIMS_data_analysis_periodic import MIMS_data_analysis_periodic

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
    app.register_blueprint(development_log, url_prefix='/')
    app.register_blueprint(MIMS_data_analysis, url_prefix='/')
    app.register_blueprint(MIMS_data_analysis_periodic, url_prefix='/')

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

    return app

def create_database(app):
    if not path.exists('website/' + DB_NAME):
        db.create_all(app) #WORKING VERSION: db.create_all(app=app)
        print('Created Database!')