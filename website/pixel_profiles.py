from flask import Blueprint, render_template, request, flash, redirect

pixel_profiles = Blueprint('pixel_profiles', __name__)

@pixel_profiles.route('/pixel_profiles', methods=['GET', 'POST'])

def get_pixel_profiles():
    return render_template("pixel_profiles.html")