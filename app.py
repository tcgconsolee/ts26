import os
from datetime import datetime
from flask import Flask, render_template, request, redirect, url_for, session, jsonify, flash
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.config['SECRET_KEY'] = 'imperial-terminal-secret-key-2026'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///database.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)

# ==========================================
# DATABASE MODELS
# ==========================================

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(250), nullable=False)
    role = db.Column(db.String(20), default='CITIZEN')  # ADMIN, MILITARY, CITIZEN
    volunteered = db.Column(db.Integer, default=0)
    reports_count = db.Column(db.Integer, default=0)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class IncidentReport(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    incident_type = db.Column(db.String(100), nullable=False)
    location = db.Column(db.String(100), nullable=False)
    sector = db.Column(db.String(50), default='OUTER RIM')
    timestamp = db.Column(db.String(50), nullable=False)
    status = db.Column(db.String(20), default='UNVERIFIED') # UNVERIFIED, CONFIRMED
    description = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Bounty(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    target_name = db.Column(db.String(100), nullable=False)
    reward = db.Column(db.String(50), nullable=False)
    status = db.Column(db.String(20), default='ACTIVE') # ACTIVE, CAPTURED
    description = db.Column(db.Text, nullable=True)


# Initialize Database & Default Admin Account
with app.app_context():
    db.create_all()
    if not User.query.filter_by(username='admin').first():
        admin_user = User(username='admin', role='ADMIN')
        admin_user.set_password('admin123')
        db.session.add(admin_user)
        db.session.commit()

# ==========================================
# PAGE ROUTES
# ==========================================

@app.route('/')
def home():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template('index.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('uname')
        password = request.form.get('psw')

        user = User.query.filter_by(username=username).first()

        if user and user.check_password(password):
            session['user_id'] = user.id
            session['username'] = user.username
            session['role'] = user.role
            return redirect(url_for('home'))
        
        flash('Invalid credentials. Access Denied.')
        return render_template('login.html', error="INVALID CREDENTIALS")

    return render_template('login.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.route('/services')
def services():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template('services.html')


@app.route('/admin')
def admin():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template('admin.html')


@app.route('/military')
def military():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template('military.html')


@app.route('/bounty')
def bounty():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    bounties = Bounty.query.filter_by(status='ACTIVE').all()
    return render_template('bounty.html', bounties=bounties)


@app.route('/report', methods=['GET', 'POST'])
def report():
    if 'user_id' not in session:
        return redirect(url_for('login'))

    if request.method == 'POST':
        # Match 'time' from the HTML form input name attribute
        timestamp_val = request.form.get('time') or datetime.utcnow().strftime('%H:%M:%S')

        new_report = IncidentReport(
            incident_type=request.form.get('incident_type'),
            location=request.form.get('location'),
            sector=request.form.get('sector', 'OUTER RIM'),
            timestamp=timestamp_val,  # Value is guaranteed not to be None
            status='UNVERIFIED',
            description=request.form.get('description')
        )

        # Increment report counter for current user
        user = User.query.get(session['user_id'])
        if user:
            user.reports_count += 1

        db.session.add(new_report)
        db.session.commit()

        return redirect(url_for('report'))

    # Fetch verified reports for bottom panel
    latest_reports = IncidentReport.query.order_by(IncidentReport.created_at.desc()).limit(6).all()
    return render_template('report.html', reports=latest_reports)


# ==========================================
# API ENDPOINTS (DATA FEED)
# ==========================================

@app.route('/api/reports', methods=['GET'])
def get_reports():
    reports = IncidentReport.query.order_by(IncidentReport.created_at.desc()).limit(10).all()
    return jsonify([{
        'id': r.id,
        'type': r.incident_type,
        'location': r.location,
        'sector': r.sector,
        'status': r.status,
        'timestamp': r.timestamp,
        'details': r.description
    } for r in reports])


@app.route('/api/users/ranks', methods=['GET'])
def get_citizen_ranks():
    users = User.query.order_by(User.reports_count.desc()).limit(5).all()
    return jsonify([{
        'username': u.username,
        'volunteered': f"{u.volunteered}D",
        'reports': u.reports_count
    } for u in users])

# ==========================================
# SECONDARY ENDPOINT ROUTES
# ==========================================

@app.route('/reports/all')
def reports_all():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    all_reports = IncidentReport.query.order_by(IncidentReport.created_at.desc()).all()
    return render_template('reports_all.html', reports=all_reports)


@app.route('/bounty/submit', methods=['GET', 'POST'])
def bounty_submit():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    
    if request.method == 'POST':
        target = request.form.get('target_name')
        reward = request.form.get('reward')
        description = request.form.get('description')

        new_bounty = Bounty(
            target_name=target,
            reward=reward,
            description=description,
            status='ACTIVE'
        )
        db.session.add(new_bounty)
        db.session.commit()
        return redirect(url_for('bounty'))

    return render_template('bounty_submit.html')


@app.route('/military/volunteer', methods=['GET', 'POST'])
def volunteer():
    if 'user_id' not in session:
        return redirect(url_for('login'))

    if request.method == 'POST':
        user = User.query.get(session['user_id'])
        if user:
            user.volunteered += 1
            db.session.commit()
        return redirect(url_for('military'))

    return render_template('volunteer.html')

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)