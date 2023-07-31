from flask import Blueprint, render_template, request, flash, redirect
from PIL import Image as im
import os, cv2
import numpy as np
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

cell_count_filament = Blueprint('cell_count_filament', __name__)

@cell_count_filament.route('/cell_count_filament', methods=['GET', 'POST'])
def count_filament_cells():
    if current_user.is_authenticated:
        return render_template("cell_count_filament.html")
    else:
        flash('Please login', category='error')
        return redirect("/login")









