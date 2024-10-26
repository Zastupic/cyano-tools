from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

calculators = Blueprint('calculators', __name__)

@calculators.route('/calculators', methods=['GET', 'POST'])
def run_calculators():
    return render_template("calculators.html")