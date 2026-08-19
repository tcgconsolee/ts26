import os
import secrets
import string
from datetime import datetime, timezone
from functools import wraps

from flask import (Flask, render_template, request, redirect,
                   url_for, flash, session, jsonify, abort)
from werkzeug.security import check_password_hash, generate_password_hash
from flask_sqlalchemy import SQLAlchemy
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'imperial-terminal-secret-key-2026')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///database.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# ── Trusted-proxy configuration ────────────────────────────────────────────────
# When running directly (no proxy) this stays 0 and remote_addr is the real IP.
# If you deploy behind nginx / Render's proxy, set TRUSTED_PROXY_DEPTH=1 in the
# environment so that X-Forwarded-For is trusted for exactly one hop.
_proxy_depth = int(os.environ.get('TRUSTED_PROXY_DEPTH', '0'))
if _proxy_depth > 0:
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=_proxy_depth,
                            x_proto=1, x_host=1, x_prefix=1)

db = SQLAlchemy(app)

# Rate limiter — uses the (possibly proxy-fixed) remote address.
# Memory storage is fine for a single-process dev server; swap for Redis in prod.
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[],          # no blanket limit; apply per-route
    storage_uri='memory://',
)


# ──────────────────────────────────────────────────────────────────────────────
# DATABASE MODELS
# ──────────────────────────────────────────────────────────────────────────────

class User(db.Model):
    id            = db.Column(db.Integer, primary_key=True)
    username      = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(250), nullable=False)
    role          = db.Column(db.String(20), default='CITIZEN')  # ADMIN, MILITARY, CITIZEN
    volunteered   = db.Column(db.Integer, default=0)
    reports_count = db.Column(db.Integer, default=0)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class IncidentReport(db.Model):
    id            = db.Column(db.Integer, primary_key=True)
    incident_type = db.Column(db.String(100), nullable=False)
    location      = db.Column(db.String(100), nullable=False)
    sector        = db.Column(db.String(50), default='OUTER RIM')
    timestamp     = db.Column(db.String(50), nullable=False)
    status        = db.Column(db.String(20), default='UNVERIFIED')
    description   = db.Column(db.Text, nullable=True)
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)


class Bounty(db.Model):
    id          = db.Column(db.Integer, primary_key=True)
    target_name = db.Column(db.String(100), nullable=False)
    reward      = db.Column(db.String(50), nullable=False)
    status      = db.Column(db.String(20), default='ACTIVE')
    description = db.Column(db.Text, nullable=True)


class HoneypotEvent(db.Model):
    """Silently recorded whenever /internal is hit."""
    __tablename__ = 'honeypot_event'

    id         = db.Column(db.Integer, primary_key=True)
    ping_id    = db.Column(db.String(16), unique=True, nullable=False)
    ip_address = db.Column(db.String(45), nullable=False)   # up to IPv6 length
    created_at = db.Column(db.DateTime, nullable=False)
    path       = db.Column(db.String(255), nullable=False)
    method     = db.Column(db.String(10), nullable=False)
    user_agent = db.Column(db.String(512), nullable=True)
    session_id = db.Column(db.String(128), nullable=True)   # Flask session identifier if present


# ── Database initialisation ───────────────────────────────────────────────────
with app.app_context():
    db.create_all()

    if not User.query.filter_by(username='admin').first():
        admin_user = User(username='admin', role='ADMIN')
        admin_user.set_password('admin123')
        db.session.add(admin_user)

    if not db.session.get(Bounty, 1):
        default_bounty = Bounty(
            id=1,
            target_name='Anakin Skywalker',
            reward='100,000 CREDITS',
            status='ACTIVE',
            description='Wanted for treason against the Galactic Empire.'
        )
        db.session.add(default_bounty)

    db.session.commit()


# ──────────────────────────────────────────────────────────────────────────────
# HELPERS & DECORATORS
# ──────────────────────────────────────────────────────────────────────────────

def _generate_ping_id() -> str:
    """
    Generate a unique, human-readable ping ID of the form JEDI-XXXXXX.
    Uses 3 bytes (6 hex chars) from the cryptographically secure RNG,
    then checks for uniqueness against existing rows.
    """
    for _ in range(10):  # retry loop — collision probability is negligible
        suffix = secrets.token_hex(3).upper()   # e.g. '7F3A91'
        candidate = f'JEDI-{suffix}'
        if not db.session.query(
            HoneypotEvent.query.filter_by(ping_id=candidate).exists()
        ).scalar():
            return candidate
    # Extremely unlikely fallback: add extra entropy
    return f'JEDI-{secrets.token_hex(4).upper()}'


def _get_client_ip() -> str:
    """
    Return the real client IP.
    ProxyFix (if enabled via TRUSTED_PROXY_DEPTH) has already rewritten
    request.remote_addr to the correct address before this is called.
    We never read X-Forwarded-For ourselves — that would allow spoofing.
    """
    return request.remote_addr or '0.0.0.0'


def _record_honeypot_event():
    """
    Persist a HoneypotEvent row. Called before returning any response from
    /internal so that the visitor receives the 404 regardless of DB errors.
    """
    try:
        ping_id    = _generate_ping_id()
        ip_address = _get_client_ip()
        created_at = datetime.now(timezone.utc).replace(tzinfo=None)  # store as naive UTC
        path       = request.path
        method     = request.method
        user_agent = (request.user_agent.string or '')[:512]
        # Use the Flask session's internal identifier if one exists; otherwise None.
        # This is a stable identifier for the browser session — not the user ID.
        sess_id    = session.get('user_id')
        session_id = str(sess_id) if sess_id is not None else None

        event = HoneypotEvent(
            ping_id=ping_id,
            ip_address=ip_address,
            created_at=created_at,
            path=path,
            method=method,
            user_agent=user_agent,
            session_id=session_id,
        )
        db.session.add(event)
        db.session.commit()
    except Exception:
        db.session.rollback()   # never let a logging error break the response


def _generate_csrf_token() -> str:
    """Create and cache a per-session CSRF token."""
    if '_csrf_token' not in session:
        session['_csrf_token'] = secrets.token_hex(32)
    return session['_csrf_token']


def _validate_csrf():
    """
    Verify the CSRF token for POST requests to protected forms.
    Raises 403 on mismatch.
    """
    token = request.form.get('_csrf_token', '')
    expected = session.get('_csrf_token', '')
    if not expected or not secrets.compare_digest(token, expected):
        abort(403)


# Make the CSRF token generator available in all Jinja templates
app.jinja_env.globals['csrf_token'] = _generate_csrf_token


def login_required(f):
    """Redirect unauthenticated visitors to /login."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    """
    Require an active session with role == 'ADMIN'.
    Returns 403 (not a redirect) so the route doesn't appear to exist for
    non-admin users who are logged in, and redirects unauthenticated
    visitors to login.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        if session.get('role') != 'ADMIN':
            abort(403)
        return f(*args, **kwargs)
    return decorated


# ──────────────────────────────────────────────────────────────────────────────
# PAGE ROUTES
# ──────────────────────────────────────────────────────────────────────────────

@app.route('/')
@login_required
def home():
    return render_template('index.html')


@app.route('/login', methods=['GET', 'POST'])
@limiter.limit('20 per minute')   # brute-force protection on the login endpoint
def login():
    if request.method == 'POST':
        _validate_csrf()
        username = request.form.get('uname', '').strip()
        password = request.form.get('psw', '')

        user = User.query.filter_by(username=username).first()

        if user and user.check_password(password):
            session['user_id']  = user.id
            session['username'] = user.username
            session['role']     = user.role
            return redirect(url_for('home'))

        flash('Invalid credentials. Access Denied.')
        return render_template('login.html', error='INVALID CREDENTIALS')

    return render_template('login.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.route('/services')
@login_required
def services():
    return render_template('services.html')


@app.route('/admin')
@login_required
def admin():
    return render_template('admin.html')


@app.route('/military')
@login_required
def military():
    return render_template('military.html')


@app.route('/bounty')
@login_required
def bounty():
    b = Bounty.query.first()
    bounty_id = b.id if b is not None else 1
    return render_template('bounty.html', bounty=bounty_id)


@app.route('/bounty/verify/<int:bounty_id>', methods=['GET'])
@login_required
def verify_bounty_page(bounty_id):
    return render_template('verification.html', bounty_id=bounty_id)


@app.route('/bounty/verify/<int:bounty_id>', methods=['POST'])
@login_required
def verify_bounty(bounty_id):
    user         = db.session.get(User, session['user_id'])
    password     = request.form.get('password')
    target_input = request.form.get('target_name', '').strip().lower()
    saber_color  = request.form.get('saber_color', '').strip().lower()

    if not user or not check_password_hash(user.password_hash, password):
        flash('AUTHENTICATION FAILED: Incorrect password.', 'error')
        return redirect(url_for('verify_bounty_page', bounty_id=bounty_id))

    if saber_color not in ('blue', 'red'):
        flash('VERIFICATION FAILED: Target identification mismatch.', 'error')
        return redirect(url_for('verify_bounty_page', bounty_id=bounty_id))

    if target_input == 'anakin skywalker':
        b = db.session.get(Bounty, bounty_id)
        if b is None:
            abort(404)
        b.status = 'CLAIMED'
        db.session.commit()
        return redirect(url_for('bounty', claimed='1'))

    elif target_input == 'darth vader':
        if saber_color == 'blue':
            b = db.session.get(Bounty, bounty_id)
            if b is None:
                abort(404)
            b.status = 'CLAIMED'
            db.session.commit()
            return redirect(url_for('bounty', claimed='1'))
        elif saber_color == 'red':
            return redirect(url_for('darth_vader_event', bounty_id=bounty_id))

    flash('VERIFICATION FAILED: Target identification mismatch.', 'error')
    return redirect(url_for('verify_bounty_page', bounty_id=bounty_id))


@app.route('/bounty/darth-vader/<int:bounty_id>')
def darth_vader_event(bounty_id):
    return render_template('darth_vader.html')


@app.route('/report', methods=['GET', 'POST'])
@login_required
def report():
    if request.method == 'POST':
        timestamp_val = request.form.get('time') or datetime.utcnow().strftime('%H:%M:%S')

        new_report = IncidentReport(
            incident_type=request.form.get('incident_type'),
            location=request.form.get('location'),
            sector=request.form.get('sector', 'OUTER RIM'),
            timestamp=timestamp_val,
            status='UNVERIFIED',
            description=request.form.get('description'),
        )

        user = db.session.get(User, session['user_id'])
        if user:
            user.reports_count += 1

        db.session.add(new_report)
        db.session.commit()
        return redirect(url_for('report'))

    latest_reports = (IncidentReport.query
                      .order_by(IncidentReport.created_at.desc())
                      .limit(6).all())
    return render_template('report.html', reports=latest_reports)


# ──────────────────────────────────────────────────────────────────────────────
# HONEYPOT — /internal
# ──────────────────────────────────────────────────────────────────────────────

@app.route('/internal', methods=['GET', 'POST', 'HEAD', 'PUT', 'DELETE',
                                  'PATCH', 'OPTIONS'])
def internal():
    """
    Public-facing honeypot endpoint.

    Silently records every request, then returns a stock Flask 404 response.
    No session, auth, or detection information is disclosed in the response.
    """
    _record_honeypot_event()
    # Return the standard Werkzeug/Flask 404 body with a genuine 404 status.
    return (
        '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
        '<title>404 Not Found</title>\n'
        '<h1>Not Found</h1>\n'
        '<p>The requested URL was not found on the server. '
        'If you entered the URL manually please check your spelling and try again.</p>\n',
        404,
        {'Content-Type': 'text/html; charset=utf-8'},
    )


# ──────────────────────────────────────────────────────────────────────────────
# HONEYPOT ADMIN — /imperial/security
# ──────────────────────────────────────────────────────────────────────────────

_SECURITY_PAGE_SIZE = 25   # events per page


@app.route('/internal/security')
@admin_required
@limiter.limit('60 per minute')
def imperial_security():
    """
    Private admin page showing all honeypot events, newest first, paginated.
    Only accessible to users with role == 'ADMIN'.
    """
    page = request.args.get('page', 1, type=int)
    if page < 1:
        page = 1

    pagination = (HoneypotEvent.query
                  .order_by(HoneypotEvent.created_at.desc())
                  .paginate(page=page, per_page=_SECURITY_PAGE_SIZE, error_out=False))

    return render_template(
        'imperial_security.html',
        events=pagination.items,
        pagination=pagination,
        page=page,
    )


# ──────────────────────────────────────────────────────────────────────────────
# API ENDPOINTS
# ──────────────────────────────────────────────────────────────────────────────

@app.route('/api/reports', methods=['GET'])
def get_reports():
    reports = (IncidentReport.query
               .order_by(IncidentReport.created_at.desc())
               .limit(10).all())
    return jsonify([{
        'id':       r.id,
        'type':     r.incident_type,
        'location': r.location,
        'sector':   r.sector,
        'status':   r.status,
        'timestamp': r.timestamp,
        'details':  r.description,
    } for r in reports])


@app.route('/api/users/ranks', methods=['GET'])
def get_citizen_ranks():
    users = (User.query
             .order_by(User.reports_count.desc())
             .limit(5).all())
    return jsonify([{
        'username':    u.username,
        'volunteered': f'{u.volunteered}D',
        'reports':     u.reports_count,
    } for u in users])


# ──────────────────────────────────────────────────────────────────────────────
# SECONDARY ROUTES
# ──────────────────────────────────────────────────────────────────────────────

@app.route('/reports/all')
@login_required
def reports_all():
    all_reports = (IncidentReport.query
                   .order_by(IncidentReport.created_at.desc()).all())
    return render_template('reports_all.html', reports=all_reports)


@app.route('/bounty/submit', methods=['GET', 'POST'])
@login_required
def bounty_submit():
    if request.method == 'POST':
        new_bounty = Bounty(
            target_name=request.form.get('target_name'),
            reward=request.form.get('reward'),
            description=request.form.get('description'),
            status='ACTIVE',
        )
        db.session.add(new_bounty)
        db.session.commit()
        return redirect(url_for('bounty'))

    return render_template('bounty_submit.html')


@app.route('/military/volunteer', methods=['GET', 'POST'])
@login_required
def volunteer():
    if request.method == 'POST':
        user = db.session.get(User, session['user_id'])
        if user:
            user.volunteered += 1
            db.session.commit()
        return redirect(url_for('military'))

    return render_template('volunteer.html')


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=10000)
