from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

slow_kin_data_analysis = Blueprint('slow_kin_data_analysis', __name__)

@slow_kin_data_analysis.route('/slow_kin_data_analysis', methods=['GET', 'POST'])
def analyze_slow_kin_data():
    return render_template("slow_kin_data_analysis.html")