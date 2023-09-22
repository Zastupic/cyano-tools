from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

OJIP_data_analysis = Blueprint('OJIP_data_analysis', __name__)

@OJIP_data_analysis.route('/OJIP_data_analysis', methods=['GET', 'POST'])
def analyze_OJIP_curves():
    return render_template("OJIP_analysis.html")