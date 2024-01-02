from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

ex_em_spectra_analysis = Blueprint('ex_em_spectra_analysis', __name__)

@ex_em_spectra_analysis.route('/ex_em_spectra_analysis', methods=['GET', 'POST'])
def analyze_ex_em_spectra():
    if current_user.is_authenticated:
        return render_template("ex_em_spectra_analysis.html")
    else:
        flash('Please login', category='error')
        return redirect("/login")