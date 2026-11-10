const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { signToken } = require('../middleware/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{2,50}$/;
const MIN_PASSWORD_LENGTH = 6;

async function register(req, res) {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-50 characters (letters, numbers, _ -)' });
  }

  if (!EMAIL_RE.test(email) || email.length > 255) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
    return res.status(400).json({ error: `Password must be ${MIN_PASSWORD_LENGTH}-128 characters` });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, hash]
    );
    const user = rows[0];
    const token = signToken({ id: user.id, username: user.username });
    res.status(201).json({ user, token });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
}

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken({ id: user.id, username: user.username });
    res.json({ user: { id: user.id, username: user.username, email: user.email }, token });
  } catch {
    res.status(500).json({ error: 'Login failed' });
  }
}

async function me(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, email, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
}

module.exports = { register, login, me };
