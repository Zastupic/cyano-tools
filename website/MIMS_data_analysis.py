from flask import Blueprint, render_template, redirect, url_for

MIMS_data_analysis = Blueprint('MIMS_data_analysis', __name__)

@MIMS_data_analysis.route('/MIMS', methods=['GET', 'POST'])
def analyze_MIMS_data():
    return render_template("MIMS_data_analysis.html")

@MIMS_data_analysis.route('/MIMS_data_analysis', methods=['GET', 'POST'])
def MIMS_redirect():
    return redirect(url_for('MIMS_data_analysis.analyze_MIMS_data'), 301)
