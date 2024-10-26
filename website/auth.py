from flask import Blueprint, render_template, request, flash, redirect, url_for
from .models import User
from werkzeug.security import generate_password_hash, check_password_hash
from .shared import db
from flask_login import login_user, login_required, logout_user, current_user

auth = Blueprint('auth', __name__)

@auth.route('/')
#@login_required
def index():
    return render_template("index.html")

@auth.route('/login', methods=['GET', 'POST']) # GET: initiated by typing the http address, POST:initiated by hitting a button
def login():
    if request.method == 'POST':
        next = request.args.get('next')
        email = request.form.get('email')
        password = str(request.form.get('password'))

        user = User.query.filter_by(email=email).first() # find user with email in database

        if user:
            if check_password_hash(user.password, password): # compare the hashed password with password of user
                flash('Logged in successfully!', category='success')
                login_user(user, remember=True) # keeps the user logged in
                return redirect(url_for('views.home')) # type: ignore
            else:
                flash('Incorrect password, try again', category='error')
        else:
            flash('Email does not exist, please try again or create an account', category='error') 
    return render_template("login.html", user=current_user)

@auth.route('/logout')
# this function secures that we can't access the logout page unless the user is logged in
@login_required
def logout():
    logout_user()
#    return redirect(url_for('views.home'))
    return redirect (url_for('auth.login'))

@auth.route('/sign-up', methods=['GET', 'POST'])
def sign_up():
    if request.method == 'POST':
        email = str(request.form.get('email'))
        name = str(request.form.get('name'))
        institution = str(request.form.get('institution'))
        password1 = str(request.form.get('password1'))
        password2 = str(request.form.get('password2'))

        user = User.query.filter_by(email=email).first()
        if user:
            flash('Email already exists.', category='error')
        elif len(email) == 0:
            flash('Please enter your email.', category='error')
        elif len(email) != 0 and len(email) < 4:
            flash('Email must be longer than 4 characters.', category='error')
        elif len(name) == 0:
            flash('Please enter your name.', category='error')
        elif len(name) != 0 and len(name) < 2:
            flash('Name must be longer than 1 character.', category='error')
        elif len(institution) == 0:
            flash('Please enter your institution.', category='error')
        elif len(institution) != 0 and len(institution) < 4:
            flash('Insitution must be longer than three characters.', category='error')
        elif len(password1) == 0:
            flash('Please enter password.', category='error')
        elif len(password1) != 0 and len(password1)< 7:
            flash('Password must be at least 7 characters.', category='error')
        elif len(password2) == 0:
            flash('Please repeat password.', category='error')
        elif password1 != password2:
            flash('Passwords don\'t match.', category='error')
        else:
           new_user = User(email=email, name=name, institution=institution, password=generate_password_hash(password1, method='sha256')) # password encrypted with algorithm 'sha256'
           db.session.add(new_user)
           db.session.commit() # update the database
           flash('Account created!', category='success')
           return redirect(url_for('auth.login'))
    return render_template("sign_up.html", user=current_user)