from .__init__ import db
from flask_login import UserMixin
from datetime import datetime

class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(100), unique=True)
    password = db.Column(db.String(256))
    name = db.Column(db.String(150))
    institution = db.Column(db.String(150))

    def __init__(self, email: str, name: str, institution: str, password: str):
        self.email = email
        self.name = name
        self.institution = institution
        self.password = password

class PageView(db.Model):
    __tablename__ = 'page_view'
    id        = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, index=True)
    path      = db.Column(db.String(200), nullable=False, index=True)
    ip_hash   = db.Column(db.String(16))   # first 16 hex chars of SHA-256(ip+date)
    referrer  = db.Column(db.String(500))
    user_agent  = db.Column(db.String(300))  # raw UA for retroactive analysis
    is_bot      = db.Column(db.Boolean, default=False, index=True)
    js_verified = db.Column(db.Boolean, default=False)  # True when client-side beacon fires
    px_verified = db.Column(db.Boolean, default=False)  # True when tracking pixel fires
    source      = db.Column(db.String(50))   # normalised traffic source (google, direct, …)
    country_code = db.Column(db.String(2))   # ISO 3166-1 alpha-2 from GeoIP lookup


class BotHash(db.Model):
    """IP hashes flagged as bots via honeypot or webdriver detection.

    Scoped to the daily salt window — hashes rotate daily, so entries
    naturally become irrelevant after 24h.
    """
    __tablename__ = 'bot_hash'
    id      = db.Column(db.Integer, primary_key=True)
    ip_hash = db.Column(db.String(16), nullable=False, index=True)
    date    = db.Column(db.String(10), nullable=False)   # 'YYYY-MM-DD'
    reason  = db.Column(db.String(30))                   # 'honeypot', 'webdriver'
    __table_args__ = (
        db.UniqueConstraint('ip_hash', 'date', name='uq_bot_hash_date'),
    )
