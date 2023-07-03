#from .__init__ import db
#from flask_login import UserMixin # flask_login: a custom class that can give our user object specifc for flask login
#from sqlalchemy.sql import func
#
## this we define for saving notes form the users
#class Note(db.Model):
#    id = db.Column(db.Integer, primary_key=True)
#    data = db.Column(db.String(10000))
#    date = db.Column(db.DateTime(timezone=True), default=func.now())
#    # association with the user, using FOREIGN KEY
#    # FOREIGN KEY is a column in the database which references another column in the database
#    # it needs to match with type of id column
#    # this is one-to-many relationship (one user writes many notes)
#    # user.id: it represents "User" class, but the capital "U" is changed to lowercase in case of FOREING KEY
#    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
#
#
## in database we need to define name of the stored objects
## User: a define object in the database, typically a singular
## db: SQLAlchemy object
## db.model: a "blueprint" of the object stored in the database
## UserMixin: another inihertinig, for the User object only
## inside the object we store all columns of the table
#class User(db.Model, UserMixin):
#    # db.Column: the id will be stored in a column
#    # db.integer: type of value in the column
#    # primary_key=True: id is the primary key
#    id = db.Column(db.Integer, primary_key=True)
#    # db.string(100): type of value in the column, (100): maximal length
#    # unique=True: every email has to be unique
#    email = db.Column(db.String(100), unique=True)
#    password = db.Column(db.String(50))
#    name = db.Column(db.String(150))
#    institution = db.Column(db.String(150))
#    # it will save relationship for the created notes in the User object
#    # this time "Note" needs to be with capital "N" (insonsistent, but this is how it works for RELATIONSHIP)
#    notes = db.relationship('Note')