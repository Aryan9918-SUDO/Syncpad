const request = require('supertest');
const { app } = require('../src/app');
const pool = require('../src/config/db');

let token;
let userId;
let docId;

beforeAll(async () => {
  await pool.query('DELETE FROM document_collaborators');
  await pool.query('DELETE FROM documents');
  await pool.query('DELETE FROM users');

  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: 'docuser', email: 'docuser@test.com', password: 'pass123' });

  token = res.body.token;
  userId = res.body.user.id;
});

afterAll(async () => {
  await pool.end();
});

describe('POST /api/documents', () => {
  it('creates a document', async () => {
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Test Doc', language: 'python' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Test Doc');
    expect(res.body.language).toBe('python');
    expect(res.body.owner_id).toBe(userId);
    docId = res.body.id;
  });

  it('creates a document with defaults', async () => {
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Untitled');
    expect(res.body.language).toBe('javascript');
  });

  it('rejects unauthenticated request', async () => {
    const res = await request(app).post('/api/documents').send({ title: 'Nope' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/documents', () => {
  it('lists user documents', async () => {
    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/documents/:id', () => {
  it('returns a specific document', async () => {
    const res = await request(app)
      .get(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Test Doc');
  });

  it('returns 404 for non-existent doc', async () => {
    const res = await request(app)
      .get('/api/documents/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe('PUT /api/documents/:id', () => {
  it('updates document title', async () => {
    const res = await request(app)
      .put(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated Title' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated Title');
  });

  it('updates document language', async () => {
    const res = await request(app)
      .put(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language: 'html' });

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('html');
  });
});

describe('DELETE /api/documents/:id', () => {
  it('deletes the document', async () => {
    const res = await request(app)
      .delete(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
  });

  it('returns 404 for already deleted doc', async () => {
    const res = await request(app)
      .delete(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe('Collaborators', () => {
  let collabDocId;
  let otherToken;
  let otherUserId;

  beforeAll(async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Collab Doc' });
    collabDocId = docRes.body.id;

    const userRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'bob', email: 'bob@test.com', password: 'pass123' });
    otherToken = userRes.body.token;
    otherUserId = userRes.body.user.id;
  });

  it('adds a collaborator', async () => {
    const res = await request(app)
      .post(`/api/documents/${collabDocId}/collaborators`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: otherUserId });

    expect(res.status).toBe(201);
  });

  it('lists collaborators', async () => {
    const res = await request(app)
      .get(`/api/documents/${collabDocId}/collaborators`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].username).toBe('bob');
  });

  it('collaborator can access the document', async () => {
    const res = await request(app)
      .get(`/api/documents/${collabDocId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Collab Doc');
  });

  it('searches users', async () => {
    const res = await request(app)
      .get('/api/documents/search-users?q=bob')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('removes a collaborator', async () => {
    const res = await request(app)
      .delete(`/api/documents/${collabDocId}/collaborators/${otherUserId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
  });
});
