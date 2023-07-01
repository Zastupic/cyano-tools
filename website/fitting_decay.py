from flask import Blueprint, render_template

fitting_decay = Blueprint('fitting_decay', __name__)

@fitting_decay.route('/fitting_decay', methods=['GET', 'POST'])
def get_decay_fit():
    return render_template("fitting_decay.html")





