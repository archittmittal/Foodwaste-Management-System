from flask import Flask, render_template, request, redirect, url_for, session, flash
import mysql.connector
from mysql.connector import Error

app = Flask(__name__)
app.secret_key = "wastenot_secret_key"

# ---------- DATABASE CONNECTION ----------
def get_db_connection():
    try:
        connection = mysql.connector.connect(
            host='localhost',
            user='root',  # your MySQL username
            password='yourpassword',  # your MySQL password
            database='wastenot_db'
        )
        return connection
    except Error as e:
        print("Error:", e)
        return None


# ---------- ROUTES ----------
@app.route('/')
def home():
    return render_template('index.html')

# ---------- SIGNUP ----------
@app.route('/signup', methods=['POST'])
def signup():
    role = request.form['role']
    name = request.form['name']
    email = request.form['email']
    password = request.form['password']
    org = request.form['organization']
    location = request.form['location']

    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM users WHERE email=%s", (email,))
    existing = cursor.fetchone()

    if existing:
        flash("User already exists! Please login.")
        return redirect(url_for('home'))

    cursor.execute("INSERT INTO users (name, email, password, role, organization, location) VALUES (%s,%s,%s,%s,%s,%s)",
                   (name, email, password, role, org, location))
    conn.commit()
    cursor.close()
    conn.close()
    flash("Signup successful! You can now login.")
    return redirect(url_for('home'))

# ---------- LOGIN ----------
@app.route('/login', methods=['POST'])
def login():
    role = request.form['role']
    email = request.form['email']
    password = request.form['password']

    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT * FROM users WHERE email=%s AND password=%s AND role=%s", (email, password, role))
    user = cursor.fetchone()

    if user:
        session['user'] = user
        if user['role'] == 'donor':
            return redirect(url_for('donor_home'))
        else:
            return redirect(url_for('receiver_home'))
    else:
        flash("Invalid email, password, or role.")
        return redirect(url_for('home'))

# ---------- DASHBOARDS ----------
@app.route('/donor')
def donor_home():
    if 'user' not in session or session['user']['role'] != 'donor':
        return redirect(url_for('home'))
    return render_template('donor_home.html', user=session['user'])

@app.route('/receiver')
def receiver_home():
    if 'user' not in session or session['user']['role'] != 'receiver':
        return redirect(url_for('home'))
    return render_template('receiver_home.html', user=session['user'])

@app.route('/logout')
def logout():
    session.pop('user', None)
    flash("Logged out successfully.")
    return redirect(url_for('home'))

if __name__ == "__main__":
    app.run(debug=True)
