const request = require('supertest');
const { app } = require('../src/app');
const pool = require('../src/config/db');
const { resetDatabase } = require('./setup');

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe('POST /api/auth/register', () => {
  it('creates a new user and returns a token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'alice@test.com', password: 'pass123' });

    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('alice');
    expect(res.body.token).toBeDefined();
  });

  it('rejects duplicate username', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', email: 'alice2@test.com', password: 'pass123' });

    expect(res.status).toBe(409);
  });

  it('rejects missing fields', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'bob' });

    expect(res.status).toBe(400);
  });

  it('rejects invalid email format', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'charlie', email: 'not-an-email', password: 'pass123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('rejects short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'charlie', email: 'charlie@test.com', password: '12' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('rejects invalid username characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'bad user!', email: 'bad@test.com', password: 'pass123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@test.com', password: 'pass123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.username).toBe('alice');
  });

  it('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@test.com', password: 'wrong' });

    expect(res.status).toBe(401);
  });

  it('rejects non-existent user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'pass123' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  let token;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@test.com', password: 'pass123' });
    token = res.body.token;
  });

  it('returns user profile with valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice');
  });

  it('rejects missing token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid.token.here');

    expect(res.status).toBe(401);
  });
});
