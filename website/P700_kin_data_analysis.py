from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

P700_kin_data_analysis = Blueprint('P700_kin_data_analysis', __name__)

@P700_kin_data_analysis.route('/P700_kin_data_analysis', methods=['GET', 'POST'])
def analyze_P700_kin_data():
    return render_template("P700_kin_data_analysis.html")