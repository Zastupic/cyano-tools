from .__init__ import db
from flask_login import UserMixin
from datetime import datetime

class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(100), unique=True)
    password = db.Column(db.String(50))
    name = db.Column(db.String(150))
    institution = db.Column(db.String(150))

class PageView(db.Model):
    __tablename__ = 'page_view'
    id        = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, index=True)
    path      = db.Column(db.String(200), nullable=False, index=True)
    ip_hash   = db.Column(db.String(16))   # first 16 hex chars of SHA-256(ip+date)
    referrer  = db.Column(db.String(500))
