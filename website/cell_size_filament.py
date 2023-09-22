from flask import Blueprint, render_template, request, flash, redirect
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

cell_size_filament = Blueprint('cell_size_filament', __name__)

@cell_size_filament.route('/cell_size_filament', methods=['GET', 'POST'])
def analyze_cell_size_filament():
    return render_template("cell_size_filament.html")