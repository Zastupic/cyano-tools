from flask import Blueprint, render_template

development_log = Blueprint('development_log', __name__)

@development_log.route('/development_log', methods=['GET', 'POST'])
def run_development_log():
    return render_template("development_log.html")