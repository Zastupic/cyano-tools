from flask import Blueprint, render_template

calculators = Blueprint('calculators', __name__)

@calculators.route('/calculators', methods=['GET', 'POST'])
def run_calculators():
    return render_template("calculators.html")