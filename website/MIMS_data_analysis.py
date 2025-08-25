from flask import Blueprint, render_template

MIMS_data_analysis = Blueprint('MIMS_data_analysis', __name__)

@MIMS_data_analysis.route('/MIMS_data_analysis', methods=['GET', 'POST'])
def analyze_MIMS_data():
    return render_template("MIMS_data_analysis.html")
