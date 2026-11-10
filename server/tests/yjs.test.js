const WebSocket = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const request = require('supertest');
const { app, server } = require('../src/app');
const pool = require('../src/config/db');
const { docs, _setOrphanTimeoutMs } = require('../src/services/yjs-server');
const { resetDatabase } = require('./setup');

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_ROLE_CHANGE = 2;

let port;
let ownerToken, editorToken, viewerToken;
let editorId, viewerId;
let docId;

async function createWSClient(docName, token) {
  const ticketRes = await request(app)
    .post(`/api/documents/${docName}/ws-ticket`)
    .set('Authorization', `Bearer ${token}`);
  if (ticketRes.status !== 200) {
    throw new Error(`Ticket request failed: ${ticketRes.status}`);
  }
  return createWSClientWithTicket(docName, ticketRes.body.ticket);
}

function createWSClientWithTicket(docName, ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/yjs/${docName}?ticket=${ticket}`);
    ws.binaryType = 'arraybuffer';
    const messages = [];

    ws.on('open', () => resolve({ ws, messages }));
    ws.on('message', (data) => messages.push(new Uint8Array(data)));
    ws.on('error', reject);
  });
}

function sendSyncStep1(ws, doc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  ws.send(encoding.toUint8Array(encoder));
}

function sendUpdate(ws, update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  ws.send(encoding.toUint8Array(encoder));
}

function sendAwareness(ws, awareness, clientIds) {
  const update = awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  ws.send(encoding.toUint8Array(encoder));
}

function processSyncMessages(messages, doc, startIndex) {
  const start = startIndex || 0;
  for (let i = start; i < messages.length; i++) {
    const decoder = decoding.createDecoder(messages[i]);
    const msgType = decoding.readVarUint(decoder);
    if (msgType === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, enc, doc, null);
    }
  }
}

function extractAwarenessMessages(messages) {
  return messages.filter((msg) => {
    const decoder = decoding.createDecoder(msg);
    return decoding.readVarUint(decoder) === MSG_AWARENESS;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  await resetDatabase();

  const ownerRes = await request(app)
    .post('/api/auth/register')
    .send({ username: 'wsowner', email: 'wsowner@test.com', password: 'pass123' });
  ownerToken = ownerRes.body.token;

  const editorRes = await request(app)
    .post('/api/auth/register')
    .send({ username: 'wseditor', email: 'wseditor@test.com', password: 'pass123' });
  editorToken = editorRes.body.token;
  editorId = editorRes.body.user.id;

  const viewerRes = await request(app)
    .post('/api/auth/register')
    .send({ username: 'wsviewer', email: 'wsviewer@test.com', password: 'pass123' });
  viewerToken = viewerRes.body.token;
  viewerId = viewerRes.body.user.id;

  const docRes = await request(app)
    .post('/api/documents')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ title: 'WS Test Doc' });
  docId = docRes.body.id;

  await request(app)
    .post(`/api/documents/${docId}/collaborators`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ userId: editorId, role: 'editor' });

  await request(app)
    .post(`/api/documents/${docId}/collaborators`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ userId: viewerId, role: 'viewer' });

  await new Promise((resolve) => {
    server.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  docs.clear();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('WebSocket Authentication', () => {
  it('rejects connection without ticket', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/yjs/${docId}`);
    ws.on('error', () => done());
    ws.on('unexpected-response', (_req, res) => {
      expect(res.statusCode).toBe(401);
      done();
    });
  });

  it('rejects connection with invalid ticket', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/yjs/${docId}?ticket=invalid-ticket-value`);
    ws.on('error', () => done());
    ws.on('unexpected-response', (_req, res) => {
      expect(res.statusCode).toBe(401);
      done();
    });
  });

  it('rejects non-UUID document path', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/yjs/not-a-uuid?ticket=anything`);
    ws.on('error', () => done());
    ws.on('unexpected-response', (_req, res) => {
      expect(res.statusCode).toBe(400);
      done();
    });
  });

  it('accepts connection for document owner', async () => {
    const client = await createWSClient(docId, ownerToken);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('accepts connection for editor collaborator', async () => {
    const client = await createWSClient(docId, editorToken);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('accepts connection for viewer collaborator', async () => {
    const client = await createWSClient(docId, viewerToken);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });
});

describe('WebSocket Ticket Auth', () => {
  it('accepts connection with valid ticket', async () => {
    const ticketRes = await request(app)
      .post(`/api/documents/${docId}/ws-ticket`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(ticketRes.status).toBe(200);

    const client = await createWSClientWithTicket(docId, ticketRes.body.ticket);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('rejects consumed ticket', async () => {
    const ticketRes = await request(app)
      .post(`/api/documents/${docId}/ws-ticket`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const ticket = ticketRes.body.ticket;

    const client = await createWSClientWithTicket(docId, ticket);
    client.ws.close();
    await sleep(100);

    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/yjs/${docId}?ticket=${ticket}`);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve('error'));
    });
    expect(rejected).toBe(401);
  });

  it('rejects ticket for wrong document', async () => {
    const otherDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Other Doc' });
    const otherDocId = otherDocRes.body.id;

    const ticketRes = await request(app)
      .post(`/api/documents/${otherDocId}/ws-ticket`)
      .set('Authorization', `Bearer ${ownerToken}`);

    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/yjs/${docId}?ticket=${ticketRes.body.ticket}`);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve('error'));
    });
    expect(rejected).toBe(403);
  });
});

describe('Yjs Sync Protocol', () => {
  it('server sends SyncStep1 on connection', async () => {
    const client = await createWSClient(docId, ownerToken);
    await sleep(200);

    expect(client.messages.length).toBeGreaterThanOrEqual(1);
    const decoder = decoding.createDecoder(client.messages[0]);
    const msgType = decoding.readVarUint(decoder);
    expect(msgType).toBe(MSG_SYNC);

    client.ws.close();
  });

  it('broadcasts updates between clients', async () => {
    const client1 = await createWSClient(docId, ownerToken);
    const client2 = await createWSClient(docId, editorToken);
    await sleep(300);

    const doc1 = new Y.Doc();
    sendSyncStep1(client1.ws, doc1);
    await sleep(200);
    processSyncMessages(client1.messages, doc1);

    const doc2 = new Y.Doc();
    sendSyncStep1(client2.ws, doc2);
    await sleep(200);
    processSyncMessages(client2.messages, doc2);

    const c2MsgCountBefore = client2.messages.length;
    const text1 = doc1.getText('codemirror');
    doc1.transact(() => text1.insert(0, 'Hello from client1'));
    const update = Y.encodeStateAsUpdate(doc1);
    sendUpdate(client1.ws, update);

    await sleep(500);

    const newMessages = client2.messages.slice(c2MsgCountBefore);
    expect(newMessages.length).toBeGreaterThanOrEqual(1);
    processSyncMessages(newMessages, doc2);

    expect(doc2.getText('codemirror').toString()).toBe('Hello from client1');

    client1.ws.close();
    client2.ws.close();
    doc1.destroy();
    doc2.destroy();
  });

  it('handles bidirectional updates', async () => {
    const biDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Bidirectional Test' });
    const biDocId = biDocRes.body.id;

    await request(app)
      .post(`/api/documents/${biDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const client1 = await createWSClient(biDocId, ownerToken);
    const client2 = await createWSClient(biDocId, editorToken);
    await sleep(300);

    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    sendSyncStep1(client1.ws, doc1);
    sendSyncStep1(client2.ws, doc2);
    await sleep(500);
    processSyncMessages(client1.messages, doc1);
    processSyncMessages(client2.messages, doc2);

    const c2Before = client2.messages.length;
    const text1 = doc1.getText('codemirror');
    doc1.transact(() => text1.insert(0, 'from1'));
    sendUpdate(client1.ws, Y.encodeStateAsUpdate(doc1));
    await sleep(500);
    processSyncMessages(client2.messages, doc2, c2Before);
    expect(doc2.getText('codemirror').toString()).toBe('from1');

    const c1Before = client1.messages.length;
    const text2 = doc2.getText('codemirror');
    doc2.transact(() => text2.insert(text2.length, ' and from2'));
    sendUpdate(client2.ws, Y.encodeStateAsUpdate(doc2));
    await sleep(500);
    processSyncMessages(client1.messages, doc1, c1Before);
    expect(doc1.getText('codemirror').toString()).toBe('from1 and from2');

    client1.ws.close();
    client2.ws.close();
    doc1.destroy();
    doc2.destroy();
  });

  it('concurrent edits converge to same content', async () => {
    const convDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Convergence Test' });
    const convDocId = convDocRes.body.id;

    await request(app)
      .post(`/api/documents/${convDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const client1 = await createWSClient(convDocId, ownerToken);
    const client2 = await createWSClient(convDocId, editorToken);
    await sleep(300);

    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    sendSyncStep1(client1.ws, doc1);
    sendSyncStep1(client2.ws, doc2);
    await sleep(500);
    processSyncMessages(client1.messages, doc1);
    processSyncMessages(client2.messages, doc2);

    const c1Before = client1.messages.length;
    const c2Before = client2.messages.length;

    doc1.transact(() => doc1.getText('codemirror').insert(0, 'AAA'));
    doc2.transact(() => doc2.getText('codemirror').insert(0, 'BBB'));

    sendUpdate(client1.ws, Y.encodeStateAsUpdate(doc1));
    sendUpdate(client2.ws, Y.encodeStateAsUpdate(doc2));

    await sleep(1000);

    processSyncMessages(client1.messages, doc1, c1Before);
    processSyncMessages(client2.messages, doc2, c2Before);

    const content1 = doc1.getText('codemirror').toString();
    const content2 = doc2.getText('codemirror').toString();
    expect(content1).toBe(content2);
    expect(content1.length).toBe(6);
    expect(content1).toContain('AAA');
    expect(content1).toContain('BBB');

    client1.ws.close();
    client2.ws.close();
    doc1.destroy();
    doc2.destroy();
  });
});

describe('Awareness', () => {
  it('propagates awareness with cursor data', async () => {
    const awDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Awareness Test' });
    const awDocId = awDocRes.body.id;

    await request(app)
      .post(`/api/documents/${awDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const client1 = await createWSClient(awDocId, ownerToken);
    const client2 = await createWSClient(awDocId, editorToken);
    await sleep(300);

    const doc1 = new Y.Doc();
    const awareness1 = new awarenessProtocol.Awareness(doc1);
    awareness1.setLocalStateField('user', {
      name: 'wsowner',
      color: '#ff0000',
    });
    awareness1.setLocalStateField('cursor', {
      anchor: { index: 5 },
      head: { index: 10 },
    });

    sendAwareness(client1.ws, awareness1, [doc1.clientID]);
    await sleep(500);

    const awMessages = extractAwarenessMessages(client2.messages);
    expect(awMessages.length).toBeGreaterThanOrEqual(1);

    const lastMsg = awMessages[awMessages.length - 1];
    const dec = decoding.createDecoder(lastMsg);
    decoding.readVarUint(dec);
    const awData = decoding.readVarUint8Array(dec);

    const tempDoc = new Y.Doc();
    const tempAw = new awarenessProtocol.Awareness(tempDoc);
    awarenessProtocol.applyAwarenessUpdate(tempAw, awData, null);

    let foundCursor = false;
    for (const [_clientId, state] of tempAw.getStates()) {
      if (state.cursor) {
        foundCursor = true;
        expect(state.cursor.anchor.index).toBe(5);
        expect(state.cursor.head.index).toBe(10);
      }
      if (state.user) {
        expect(state.user.name).toBe('wsowner');
      }
    }
    expect(foundCursor).toBe(true);

    doc1.destroy();
    tempDoc.destroy();
    client1.ws.close();
    client2.ws.close();
  });

  it('sanitizes spoofed awareness identity', async () => {
    const spoofDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Spoof Test' });
    const spoofDocId = spoofDocRes.body.id;

    await request(app)
      .post(`/api/documents/${spoofDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const ownerClient = await createWSClient(spoofDocId, ownerToken);
    const editorClient = await createWSClient(spoofDocId, editorToken);
    await sleep(300);

    const spoofDoc = new Y.Doc();
    const spoofAwareness = new awarenessProtocol.Awareness(spoofDoc);
    spoofAwareness.setLocalStateField('user', {
      name: 'wsowner',
      color: '#ff0000',
    });

    sendAwareness(editorClient.ws, spoofAwareness, [spoofDoc.clientID]);
    await sleep(500);

    const awMessages = extractAwarenessMessages(ownerClient.messages);
    expect(awMessages.length).toBeGreaterThanOrEqual(1);

    let foundSpoofedName = false;
    for (const msg of awMessages) {
      const dec = decoding.createDecoder(msg);
      decoding.readVarUint(dec);
      const awData = decoding.readVarUint8Array(dec);

      const tempDoc = new Y.Doc();
      const tempAw = new awarenessProtocol.Awareness(tempDoc);
      awarenessProtocol.applyAwarenessUpdate(tempAw, awData, null);

      for (const [_clientId, state] of tempAw.getStates()) {
        if (state.user && state.user.color === '#ff0000') {
          expect(state.user.name).toBe('wseditor');
          expect(state.user.name).not.toBe('wsowner');
          foundSpoofedName = true;
        }
      }
      tempDoc.destroy();
    }
    expect(foundSpoofedName).toBe(true);

    spoofDoc.destroy();
    ownerClient.ws.close();
    editorClient.ws.close();
  });
});

describe('Role-Based Access Control', () => {
  it('viewer can connect and receive sync', async () => {
    const client = await createWSClient(docId, viewerToken);
    await sleep(200);

    expect(client.messages.length).toBeGreaterThanOrEqual(1);
    client.ws.close();
  });

  it('viewer SyncStep2/Update messages are blocked', async () => {
    const ownerClient = await createWSClient(docId, ownerToken);
    const viewerClient = await createWSClient(docId, viewerToken);
    await sleep(300);

    const viewerDoc = new Y.Doc();
    const viewerText = viewerDoc.getText('codemirror');
    viewerDoc.transact(() => viewerText.insert(0, 'viewer write attempt'));
    const update = Y.encodeStateAsUpdate(viewerDoc);
    sendUpdate(viewerClient.ws, update);

    await sleep(500);

    const serverDoc = docs.get(docId);
    if (serverDoc) {
      expect(serverDoc.getText('codemirror').toString()).not.toContain('viewer write attempt');
    }

    ownerClient.ws.close();
    viewerClient.ws.close();
    viewerDoc.destroy();
  });

  it('document API returns viewer role', async () => {
    const res = await request(app)
      .get(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('viewer');
  });
});

describe('Late Joiner', () => {
  it('late joiner receives existing content', async () => {
    const lateDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Late Join Test' });
    const lateDocId = lateDocRes.body.id;

    await request(app)
      .post(`/api/documents/${lateDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const client1 = await createWSClient(lateDocId, ownerToken);
    await sleep(200);

    const doc1 = new Y.Doc();
    sendSyncStep1(client1.ws, doc1);
    await sleep(200);
    processSyncMessages(client1.messages, doc1);

    doc1.transact(() => doc1.getText('codemirror').insert(0, 'existing content'));
    sendUpdate(client1.ws, Y.encodeStateAsUpdate(doc1));
    await sleep(500);

    const client2 = await createWSClient(lateDocId, editorToken);
    await sleep(200);

    const doc2 = new Y.Doc();
    sendSyncStep1(client2.ws, doc2);
    await sleep(500);
    processSyncMessages(client2.messages, doc2);

    expect(doc2.getText('codemirror').toString()).toBe('existing content');

    client1.ws.close();
    client2.ws.close();
    doc1.destroy();
    doc2.destroy();
  });
});

describe('Persistence', () => {
  let persistDocId;

  beforeAll(async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Persist Test' });
    persistDocId = docRes.body.id;
  });

  it('saves document state to DB and reloads', async () => {
    const client = await createWSClient(persistDocId, ownerToken);
    await sleep(200);

    const doc = new Y.Doc();
    sendSyncStep1(client.ws, doc);
    await sleep(200);

    const text = doc.getText('codemirror');
    doc.transact(() => text.insert(0, 'persisted content'));
    const update = Y.encodeStateAsUpdate(doc);
    sendUpdate(client.ws, update);

    await sleep(3000);

    client.ws.close();
    await sleep(1000);

    const { rows } = await pool.query('SELECT yjs_state FROM documents WHERE id = $1', [persistDocId]);
    expect(rows.length).toBe(1);
    expect(rows[0].yjs_state).not.toBeNull();

    const client2 = await createWSClient(persistDocId, ownerToken);
    await sleep(200);

    const doc2 = new Y.Doc();
    sendSyncStep1(client2.ws, doc2);
    await sleep(500);
    processSyncMessages(client2.messages, doc2);

    expect(doc2.getText('codemirror').toString()).toBe('persisted content');

    client2.ws.close();
    doc.destroy();
    doc2.destroy();
  }, 15000);

  it('content survives server restart simulation', async () => {
    const restartDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Restart Test' });
    const restartDocId = restartDocRes.body.id;

    const client = await createWSClient(restartDocId, ownerToken);
    await sleep(200);

    const doc = new Y.Doc();
    sendSyncStep1(client.ws, doc);
    await sleep(200);

    doc.transact(() => doc.getText('codemirror').insert(0, 'survives restart'));
    sendUpdate(client.ws, Y.encodeStateAsUpdate(doc));
    await sleep(3000);

    client.ws.close();
    await sleep(1000);

    const serverDoc = docs.get(restartDocId);
    if (serverDoc) {
      docs.delete(restartDocId);
      serverDoc.destroy();
    }

    const client2 = await createWSClient(restartDocId, ownerToken);
    await sleep(200);

    const doc2 = new Y.Doc();
    sendSyncStep1(client2.ws, doc2);
    await sleep(500);
    processSyncMessages(client2.messages, doc2);

    expect(doc2.getText('codemirror').toString()).toBe('survives restart');

    client2.ws.close();
    doc.destroy();
    doc2.destroy();
  }, 15000);
});

describe('Y.Doc Instance Sharing', () => {
  it('multiple connections share one Y.Doc instance', async () => {
    const shareDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Share Doc Test' });
    const shareDocId = shareDocRes.body.id;

    await request(app)
      .post(`/api/documents/${shareDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const client1 = await createWSClient(shareDocId, ownerToken);
    const client2 = await createWSClient(shareDocId, editorToken);
    await sleep(500);

    const serverDoc = docs.get(shareDocId);
    expect(serverDoc).toBeDefined();
    expect(serverDoc.conns.size).toBe(2);

    let docCount = 0;
    for (const [key] of docs) {
      if (key === shareDocId) docCount++;
    }
    expect(docCount).toBe(1);

    client1.ws.close();
    client2.ws.close();
  });
});

describe('Cleanup Race Condition', () => {
  it('new connection during idle cleanup preserves doc', async () => {
    const cleanupDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Cleanup Race Test' });
    const cleanupDocId = cleanupDocRes.body.id;

    await request(app)
      .post(`/api/documents/${cleanupDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const client1 = await createWSClient(cleanupDocId, ownerToken);
    await sleep(200);

    const doc1 = new Y.Doc();
    sendSyncStep1(client1.ws, doc1);
    await sleep(200);
    processSyncMessages(client1.messages, doc1);

    doc1.transact(() => doc1.getText('codemirror').insert(0, 'cleanup race'));
    sendUpdate(client1.ws, Y.encodeStateAsUpdate(doc1));
    await sleep(500);

    client1.ws.close();

    const client2 = await createWSClient(cleanupDocId, editorToken);
    await sleep(500);

    expect(client2.ws.readyState).toBe(WebSocket.OPEN);

    const doc2 = new Y.Doc();
    sendSyncStep1(client2.ws, doc2);
    await sleep(500);
    processSyncMessages(client2.messages, doc2);

    expect(doc2.getText('codemirror').toString()).toBe('cleanup race');

    client2.ws.close();
    doc1.destroy();
    doc2.destroy();
  });
});

describe('Database Failure During Cleanup', () => {
  it('retains document in memory on save failure', async () => {
    const failDocRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'DB Failure Test' });
    const failDocId = failDocRes.body.id;

    const client = await createWSClient(failDocId, ownerToken);
    await sleep(200);

    const doc = new Y.Doc();
    sendSyncStep1(client.ws, doc);
    await sleep(200);

    doc.transact(() => doc.getText('codemirror').insert(0, 'must not lose this'));
    sendUpdate(client.ws, Y.encodeStateAsUpdate(doc));
    await sleep(500);

    await pool.query('DELETE FROM document_collaborators WHERE document_id = $1', [failDocId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [failDocId]);

    client.ws.close();

    await sleep(8000);

    const serverDoc = docs.get(failDocId);
    expect(serverDoc).toBeDefined();
    expect(serverDoc.getText('codemirror').toString()).toBe('must not lose this');

    clearTimeout(serverDoc._orphanTimeout);
    docs.delete(failDocId);
    serverDoc.destroy();
    doc.destroy();
  }, 20000);
});

describe('Document Deletion with Active Sessions', () => {
  let deleteDocId;

  beforeAll(async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Delete While Connected' });
    deleteDocId = docRes.body.id;
  });

  it('closes WebSocket when document is deleted via REST', async () => {
    const client = await createWSClient(deleteDocId, ownerToken);
    await sleep(200);

    let closed = false;
    client.ws.on('close', () => { closed = true; });

    await request(app)
      .delete(`/api/documents/${deleteDocId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    await sleep(500);
    expect(closed).toBe(true);
  });
});

describe('Connection Invalidation on Permission Changes', () => {
  it('closes editor connection when collaborator is removed', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Revoke Test' });
    const revokeDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${revokeDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const editorClient = await createWSClient(revokeDocId, editorToken);
    await sleep(200);

    let closeCode;
    editorClient.ws.on('close', (code) => { closeCode = code; });

    await request(app)
      .delete(`/api/documents/${revokeDocId}/collaborators/${editorId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    await sleep(500);
    expect(closeCode).toBe(4403);
  });

  it('blocks writes after editor is demoted to viewer', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Demotion Test' });
    const demoteDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${demoteDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const ownerClient = await createWSClient(demoteDocId, ownerToken);
    const editorClient = await createWSClient(demoteDocId, editorToken);
    await sleep(300);

    const editorDoc = new Y.Doc();
    sendSyncStep1(editorClient.ws, editorDoc);
    await sleep(200);

    editorDoc.transact(() => editorDoc.getText('codemirror').insert(0, 'before demotion'));
    sendUpdate(editorClient.ws, Y.encodeStateAsUpdate(editorDoc));
    await sleep(500);

    const serverDoc = docs.get(demoteDocId);
    expect(serverDoc.getText('codemirror').toString()).toContain('before demotion');

    await request(app)
      .post(`/api/documents/${demoteDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'viewer' });
    await sleep(200);

    editorDoc.transact(() => editorDoc.getText('codemirror').insert(0, 'BLOCKED '));
    sendUpdate(editorClient.ws, Y.encodeStateAsUpdate(editorDoc));
    await sleep(500);

    expect(serverDoc.getText('codemirror').toString()).not.toContain('BLOCKED');

    ownerClient.ws.close();
    editorClient.ws.close();
    editorDoc.destroy();
  });

  it('sends role-change message when editor is demoted to viewer', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Role Notify Demote' });
    const notifyDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${notifyDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const editorClient = await createWSClient(notifyDocId, editorToken);
    await sleep(300);
    const msgsBefore = editorClient.messages.length;

    await request(app)
      .post(`/api/documents/${notifyDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'viewer' });
    await sleep(200);

    const newMsgs = editorClient.messages.slice(msgsBefore);
    const roleMsg = newMsgs.find((m) => {
      const dec = decoding.createDecoder(m);
      return decoding.readVarUint(dec) === MSG_ROLE_CHANGE;
    });
    expect(roleMsg).toBeDefined();

    const dec = decoding.createDecoder(roleMsg);
    decoding.readVarUint(dec);
    expect(decoding.readVarString(dec)).toBe('viewer');

    editorClient.ws.close();
  });

  it('sends role-change message when viewer is promoted to editor', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Role Notify Promote' });
    const promoteDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${promoteDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: viewerId, role: 'viewer' });

    const viewerClient = await createWSClient(promoteDocId, viewerToken);
    await sleep(300);

    const doc = new Y.Doc();
    sendSyncStep1(viewerClient.ws, doc);
    await sleep(200);

    doc.transact(() => doc.getText('codemirror').insert(0, 'should fail'));
    sendUpdate(viewerClient.ws, Y.encodeStateAsUpdate(doc));
    await sleep(300);

    const serverDoc = docs.get(promoteDocId);
    expect(serverDoc.getText('codemirror').toString()).not.toContain('should fail');

    const msgsBefore = viewerClient.messages.length;

    await request(app)
      .post(`/api/documents/${promoteDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: viewerId, role: 'editor' });
    await sleep(200);

    const newMsgs = viewerClient.messages.slice(msgsBefore);
    const roleMsg = newMsgs.find((m) => {
      const dec = decoding.createDecoder(m);
      return decoding.readVarUint(dec) === MSG_ROLE_CHANGE;
    });
    expect(roleMsg).toBeDefined();
    const dec = decoding.createDecoder(roleMsg);
    decoding.readVarUint(dec);
    expect(decoding.readVarString(dec)).toBe('editor');

    doc.transact(() => doc.getText('codemirror').insert(0, 'now allowed '));
    sendUpdate(viewerClient.ws, Y.encodeStateAsUpdate(doc));
    await sleep(500);

    expect(serverDoc.getText('codemirror').toString()).toContain('now allowed');

    viewerClient.ws.close();
    doc.destroy();
  });

  it('rejects ticket issued before collaborator removal', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Stale Ticket Removal' });
    const staleDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${staleDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const ticketRes = await request(app)
      .post(`/api/documents/${staleDocId}/ws-ticket`)
      .set('Authorization', `Bearer ${editorToken}`);
    const ticket = ticketRes.body.ticket;

    await request(app)
      .delete(`/api/documents/${staleDocId}/collaborators/${editorId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/yjs/${staleDocId}?ticket=${ticket}`);
      ws.on('open', () => resolve('open'));
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve('error'));
    });
    expect(result).toBe(401);
  });

  it('enforces current role for ticket issued before demotion', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Stale Ticket Demotion' });
    const demoteTicketDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${demoteTicketDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const ticketRes = await request(app)
      .post(`/api/documents/${demoteTicketDocId}/ws-ticket`)
      .set('Authorization', `Bearer ${editorToken}`);
    const ticket = ticketRes.body.ticket;

    await request(app)
      .post(`/api/documents/${demoteTicketDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'viewer' });

    const client = await createWSClientWithTicket(demoteTicketDocId, ticket);
    await sleep(300);

    const editorDoc = new Y.Doc();
    sendSyncStep1(client.ws, editorDoc);
    await sleep(200);
    editorDoc.transact(() => editorDoc.getText('codemirror').insert(0, 'should be blocked'));
    sendUpdate(client.ws, Y.encodeStateAsUpdate(editorDoc));
    await sleep(500);

    const serverDoc = docs.get(demoteTicketDocId);
    expect(serverDoc.getText('codemirror').toString()).not.toContain('should be blocked');

    client.ws.close();
    editorDoc.destroy();
  });
});

describe('Orphan Timeout Behavior', () => {
  afterEach(() => {
    _setOrphanTimeoutMs(5 * 60 * 1000);
  });

  it('retries orphan save with backoff until DB recovers', async () => {
    _setOrphanTimeoutMs(300);

    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Orphan Retry Test' });
    const retryDocId = docRes.body.id;

    const client = await createWSClient(retryDocId, ownerToken);
    await sleep(200);
    const doc = new Y.Doc();
    sendSyncStep1(client.ws, doc);
    await sleep(200);
    doc.transact(() => doc.getText('codemirror').insert(0, 'retry content'));
    sendUpdate(client.ws, Y.encodeStateAsUpdate(doc));
    await sleep(500);

    // Fail 3 cleanup attempts + 3 orphan retries, then let the 4th orphan retry succeed
    const originalQuery = pool.query.bind(pool);
    let failCount = 0;
    const spy = jest.spyOn(pool, 'query').mockImplementation((...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (sql.includes('UPDATE documents SET yjs_state') && failCount < 6) {
        failCount++;
        return Promise.reject(new Error('simulated DB outage'));
      }
      return originalQuery(...args);
    });

    client.ws.close();

    // Cleanup ~3s + orphan retries at 300ms, 600ms intervals → doc retained at 4s
    await sleep(4000);
    expect(failCount).toBeGreaterThanOrEqual(4);
    expect(docs.has(retryDocId)).toBe(true);

    // Orphan retry 3 succeeds at ~6.6s from close → doc gone by 9s
    await sleep(5000);
    spy.mockRestore();

    expect(docs.has(retryDocId)).toBe(false);

    const { rows } = await pool.query('SELECT yjs_state FROM documents WHERE id = $1', [retryDocId]);
    expect(rows[0].yjs_state).not.toBeNull();

    doc.destroy();
  }, 20000);

  it('destroys orphan doc when DB row was deliberately deleted', async () => {
    _setOrphanTimeoutMs(2000);

    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Orphan Destroy Test' });
    const orphanDocId = docRes.body.id;

    const client = await createWSClient(orphanDocId, ownerToken);
    await sleep(200);
    const doc = new Y.Doc();
    sendSyncStep1(client.ws, doc);
    await sleep(200);
    doc.transact(() => doc.getText('codemirror').insert(0, 'orphan data'));
    sendUpdate(client.ws, Y.encodeStateAsUpdate(doc));
    await sleep(500);

    await pool.query('DELETE FROM document_collaborators WHERE document_id = $1', [orphanDocId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [orphanDocId]);

    client.ws.close();
    await sleep(4000);

    expect(docs.has(orphanDocId)).toBe(true);

    await sleep(4000);

    expect(docs.has(orphanDocId)).toBe(false);

    doc.destroy();
  }, 15000);
});

describe('Awareness Hardening', () => {
  it('drops malformed JSON awareness state', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Malformed Awareness' });
    const awDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${awDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const ownerClient = await createWSClient(awDocId, ownerToken);
    const editorClient = await createWSClient(awDocId, editorToken);
    await sleep(300);

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, 99999);
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarString(encoder, '{invalid json!!!');

    const rawUpdate = encoding.toUint8Array(encoder);
    const msgEncoder = encoding.createEncoder();
    encoding.writeVarUint(msgEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(msgEncoder, rawUpdate);
    editorClient.ws.send(encoding.toUint8Array(msgEncoder));

    await sleep(500);

    const awMessages = extractAwarenessMessages(ownerClient.messages);
    let foundMalformed = false;
    for (const msg of awMessages) {
      const dec = decoding.createDecoder(msg);
      decoding.readVarUint(dec);
      const awData = decoding.readVarUint8Array(dec);
      const tempDoc = new Y.Doc();
      const tempAw = new awarenessProtocol.Awareness(tempDoc);
      awarenessProtocol.applyAwarenessUpdate(tempAw, awData, null);
      for (const [clientId] of tempAw.getStates()) {
        if (clientId === 99999) foundMalformed = true;
      }
      tempDoc.destroy();
    }
    expect(foundMalformed).toBe(false);

    ownerClient.ws.close();
    editorClient.ws.close();
  });

  it('replaces non-object awareness user with safe value', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Bad User Awareness' });
    const awDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${awDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const ownerClient = await createWSClient(awDocId, ownerToken);
    const editorClient = await createWSClient(awDocId, editorToken);
    await sleep(300);

    const spoofDoc = new Y.Doc();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, spoofDoc.clientID);
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarString(encoder, JSON.stringify({ user: 'not-an-object', cursor: { index: 5 } }));

    const rawUpdate = encoding.toUint8Array(encoder);
    const msgEncoder = encoding.createEncoder();
    encoding.writeVarUint(msgEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(msgEncoder, rawUpdate);
    editorClient.ws.send(encoding.toUint8Array(msgEncoder));

    await sleep(500);

    const awMessages = extractAwarenessMessages(ownerClient.messages);
    let foundFixed = false;
    for (const msg of awMessages) {
      const dec = decoding.createDecoder(msg);
      decoding.readVarUint(dec);
      const awData = decoding.readVarUint8Array(dec);
      const tempDoc2 = new Y.Doc();
      const tempAw = new awarenessProtocol.Awareness(tempDoc2);
      awarenessProtocol.applyAwarenessUpdate(tempAw, awData, null);
      for (const [, state] of tempAw.getStates()) {
        if (state.user && typeof state.user === 'object') {
          expect(state.user.name).toBe('wseditor');
          foundFixed = true;
        }
      }
      tempDoc2.destroy();
    }
    expect(foundFixed).toBe(true);

    spoofDoc.destroy();
    ownerClient.ws.close();
    editorClient.ws.close();
  });

  it('drops non-object JSON awareness state', async () => {
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Array Awareness' });
    const awDocId = docRes.body.id;

    await request(app)
      .post(`/api/documents/${awDocId}/collaborators`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: editorId, role: 'editor' });

    const ownerClient = await createWSClient(awDocId, ownerToken);
    const editorClient = await createWSClient(awDocId, editorToken);
    await sleep(300);

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, 88888);
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarString(encoder, JSON.stringify([1, 2, 3]));

    const rawUpdate = encoding.toUint8Array(encoder);
    const msgEncoder = encoding.createEncoder();
    encoding.writeVarUint(msgEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(msgEncoder, rawUpdate);
    editorClient.ws.send(encoding.toUint8Array(msgEncoder));

    await sleep(500);

    const awMessages = extractAwarenessMessages(ownerClient.messages);
    let foundArray = false;
    for (const msg of awMessages) {
      const dec = decoding.createDecoder(msg);
      decoding.readVarUint(dec);
      const awData = decoding.readVarUint8Array(dec);
      const tempDoc = new Y.Doc();
      const tempAw = new awarenessProtocol.Awareness(tempDoc);
      awarenessProtocol.applyAwarenessUpdate(tempAw, awData, null);
      for (const [clientId] of tempAw.getStates()) {
        if (clientId === 88888) foundArray = true;
      }
      tempDoc.destroy();
    }
    expect(foundArray).toBe(false);

    ownerClient.ws.close();
    editorClient.ws.close();
  });
});
