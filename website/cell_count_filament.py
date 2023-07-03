from flask import Blueprint, render_template

cell_count_filament = Blueprint('cell_count_filament', __name__)

@cell_count_filament.route('/cell_count_filament', methods=['GET', 'POST'])
def count_filament_cells():
    return render_template("cell_count_filament.html")





