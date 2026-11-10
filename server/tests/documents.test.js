const request = require('supertest');
const { app } = require('../src/app');
const pool = require('../src/config/db');
const { resetDatabase } = require('./setup');

let token;
let userId;
let docId;

beforeAll(async () => {
  await resetDatabase();

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
    expect(res.body.yjs_state).toBeUndefined();
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

  it('rejects invalid language', async () => {
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ language: 'brainfuck' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/documents', () => {
  it('lists user documents with role', async () => {
    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    res.body.forEach((doc) => {
      expect(doc.yjs_state).toBeUndefined();
      expect(doc.role).toBe('owner');
    });
  });
});

describe('GET /api/documents/:id', () => {
  it('returns a specific document with role', async () => {
    const res = await request(app)
      .get(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Test Doc');
    expect(res.body.yjs_state).toBeUndefined();
    expect(res.body.role).toBe('owner');
  });

  it('returns 404 for non-existent doc', async () => {
    const res = await request(app)
      .get('/api/documents/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('rejects invalid UUID', async () => {
    const res = await request(app)
      .get('/api/documents/not-a-uuid')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});

describe('PUT /api/documents/:id', () => {
  it('owner updates document title', async () => {
    const res = await request(app)
      .put(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated Title' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated Title');
  });

  it('owner updates document language', async () => {
    const res = await request(app)
      .put(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language: 'html' });

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('html');
  });

  it('rejects invalid language', async () => {
    const res = await request(app)
      .put(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language: 'invalid' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/documents/:id', () => {
  let deleteDocId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'To Delete' });
    deleteDocId = res.body.id;
  });

  it('deletes the document', async () => {
    const res = await request(app)
      .delete(`/api/documents/${deleteDocId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
  });

  it('returns 404 for already deleted doc', async () => {
    const res = await request(app)
      .delete(`/api/documents/${deleteDocId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe('Collaborators', () => {
  let collabDocId;
  let otherToken;
  let otherUserId;
  let thirdToken;
  let thirdUserId;

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

    const thirdRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'charlie', email: 'charlie@test.com', password: 'pass123' });
    thirdToken = thirdRes.body.token;
    thirdUserId = thirdRes.body.user.id;
  });

  it('adds a collaborator', async () => {
    const res = await request(app)
      .post(`/api/documents/${collabDocId}/collaborators`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: otherUserId });

    expect(res.status).toBe(201);
  });

  it('rejects invalid role', async () => {
    const res = await request(app)
      .post(`/api/documents/${collabDocId}/collaborators`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: otherUserId, role: 'admin' });

    expect(res.status).toBe(400);
  });

  it('lists collaborators (owner)', async () => {
    const res = await request(app)
      .get(`/api/documents/${collabDocId}/collaborators`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].username).toBe('bob');
  });

  it('lists collaborators (collaborator can view)', async () => {
    const res = await request(app)
      .get(`/api/documents/${collabDocId}/collaborators`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(200);
  });

  it('denies collaborator list to non-member', async () => {
    const res = await request(app)
      .get(`/api/documents/${collabDocId}/collaborators`)
      .set('Authorization', `Bearer ${thirdToken}`);

    expect(res.status).toBe(403);
  });

  it('collaborator can access the document', async () => {
    const res = await request(app)
      .get(`/api/documents/${collabDocId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Collab Doc');
    expect(res.body.role).toBe('editor');
  });

  it('editor cannot update document metadata', async () => {
    const res = await request(app)
      .put(`/api/documents/${collabDocId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ title: 'Updated by Editor' });

    expect(res.status).toBe(404);
  });

  it('viewer cannot update document metadata', async () => {
    await request(app)
      .post(`/api/documents/${collabDocId}/collaborators`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: thirdUserId, role: 'viewer' });

    const res = await request(app)
      .put(`/api/documents/${collabDocId}`)
      .set('Authorization', `Bearer ${thirdToken}`)
      .send({ title: 'Should fail' });

    expect(res.status).toBe(404);
  });

  it('returns correct role for each access level', async () => {
    const ownerRes = await request(app)
      .get(`/api/documents/${collabDocId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(ownerRes.body.role).toBe('owner');

    const editorRes = await request(app)
      .get(`/api/documents/${collabDocId}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(editorRes.body.role).toBe('editor');

    const viewerRes = await request(app)
      .get(`/api/documents/${collabDocId}`)
      .set('Authorization', `Bearer ${thirdToken}`);
    expect(viewerRes.body.role).toBe('viewer');
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

describe('WebSocket Tickets', () => {
  let ticketDocId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Ticket Test' });
    ticketDocId = res.body.id;
  });

  it('issues a ticket for authorized user', async () => {
    const res = await request(app)
      .post(`/api/documents/${ticketDocId}/ws-ticket`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ticket).toBeDefined();
    expect(typeof res.body.ticket).toBe('string');
    expect(res.body.ticket.length).toBe(64);
  });

  it('rejects ticket for unauthorized user', async () => {
    const outsiderRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'outsider', email: 'outsider@test.com', password: 'pass123' });

    const res = await request(app)
      .post(`/api/documents/${ticketDocId}/ws-ticket`)
      .set('Authorization', `Bearer ${outsiderRes.body.token}`);

    expect(res.status).toBe(403);
  });

  it('rejects ticket without auth', async () => {
    const res = await request(app)
      .post(`/api/documents/${ticketDocId}/ws-ticket`);

    expect(res.status).toBe(401);
  });
});
