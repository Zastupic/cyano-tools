from flask import Blueprint, render_template

MIMS_data_analysis_periodic = Blueprint('MIMS_data_analysis_periodic', __name__)

@MIMS_data_analysis_periodic.route('/MIMS_data_analysis_periodic', methods=['GET', 'POST'])
def analyze_MIMS_data_periodic():
    return render_template("MIMS_data_analysis_periodic.html")
