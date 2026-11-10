/**
 * 12 Scenario Demonstrations for SyncPad (v2)
 * Run from server/ directory:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/syncpad_test \
 *   JWT_SECRET=test-secret-key node scenario-tests-v2.js
 */
const WebSocket = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const BASE = 'http://localhost';
let PORT, server, _app, pool, docsMap;

async function api(method, path, body, token) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}:${PORT}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function connectWS(docId, token) {
  const ticketRes = await api('POST', `/api/documents/${docId}/ws-ticket`, null, token);
  if (ticketRes.status !== 200) throw new Error(`Ticket request failed: ${ticketRes.status}`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/yjs/${docId}?ticket=${ticketRes.data.ticket}`);
    ws.binaryType = 'arraybuffer';
    const messages = [];
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('message', (d) => messages.push(new Uint8Array(d)));
    ws.on('error', reject);
  });
}

function connectWSRaw(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve({ ws, opened: true }));
    ws.on('unexpected-response', (_req, res) => resolve({ ws: null, statusCode: res.statusCode }));
    ws.on('error', () => resolve({ ws: null, statusCode: 0 }));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sendSyncStep1(ws, doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
}

function sendUpdate(ws, doc) {
  const update = Y.encodeStateAsUpdate(doc);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  ws.send(encoding.toUint8Array(enc));
}

function applySync(messages, doc, from) {
  for (let i = (from || 0); i < messages.length; i++) {
    const dec = decoding.createDecoder(messages[i]);
    const t = decoding.readVarUint(dec);
    if (t === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, doc, null);
    }
  }
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${label}`); passed++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${label}`); failed++; }
}

// ─── Main ──────────────────────────────────────────────────────────────
(async () => {
  const { app: appInstance, server: _server } = require('./src/app');
  _app = appInstance; server = _server;
  pool = require('./src/config/db');
  docsMap = require('./src/services/yjs-server').docs;

  const dbUrl = process.env.DATABASE_URL || '';
  try {
    const parsed = new URL(dbUrl);
    const dbName = parsed.pathname.replace(/^\//, '');
    if (dbName !== 'syncpad_test') {
      throw new Error(`expected "syncpad_test", got "${dbName}"`);
    }
  } catch (err) {
    console.error(
      `SAFETY: DATABASE_URL must point to exactly "syncpad_test". ${err.message}\n` +
      `Current DATABASE_URL: ${dbUrl}`
    );
    process.exit(1);
  }

  await pool.query('DELETE FROM document_collaborators');
  await pool.query('DELETE FROM documents');
  await pool.query('DELETE FROM users');

  await new Promise((r) => server.listen(0, r));
  PORT = server.address().port;
  console.log(`\nServer on port ${PORT}\n`);

  const alice = (await api('POST', '/api/auth/register', { username: 'alice', email: 'alice@t.co', password: 'pass123' })).data;
  const bob = (await api('POST', '/api/auth/register', { username: 'bob', email: 'bob@t.co', password: 'pass123' })).data;
  const carol = (await api('POST', '/api/auth/register', { username: 'carol', email: 'carol@t.co', password: 'pass123' })).data;
  const dave = (await api('POST', '/api/auth/register', { username: 'dave', email: 'dave@t.co', password: 'pass123' })).data;

  const doc1 = (await api('POST', '/api/documents', { title: 'Main Doc' }, alice.token)).data;
  await api('POST', `/api/documents/${doc1.id}/collaborators`, { userId: bob.user.id, role: 'editor' }, alice.token);
  await api('POST', `/api/documents/${doc1.id}/collaborators`, { userId: carol.user.id, role: 'viewer' }, alice.token);

  // ─── Scenario 1 ──────────────────────────────────────────────────────
  console.log('Scenario 1: Alice and Bob exchange edits bidirectionally');
  {
    const a = await connectWS(doc1.id, alice.token);
    const b = await connectWS(doc1.id, bob.token);
    await sleep(300);
    const dA = new Y.Doc(); const dB = new Y.Doc();
    sendSyncStep1(a.ws, dA); sendSyncStep1(b.ws, dB);
    await sleep(500);
    applySync(a.messages, dA); applySync(b.messages, dB);

    const bBefore = b.messages.length;
    dA.getText('codemirror').insert(0, 'Hello from Alice. ');
    sendUpdate(a.ws, dA); await sleep(500);
    applySync(b.messages, dB, bBefore);
    assert(dB.getText('codemirror').toString().includes('Hello from Alice'), 'Bob receives Alice edit');

    const aBefore = a.messages.length;
    dB.getText('codemirror').insert(dB.getText('codemirror').length, 'Hi from Bob.');
    sendUpdate(b.ws, dB); await sleep(500);
    applySync(a.messages, dA, aBefore);
    assert(dA.getText('codemirror').toString().includes('Hi from Bob'), 'Alice receives Bob edit');

    a.ws.close(); b.ws.close(); dA.destroy(); dB.destroy();
  }

  // ─── Scenario 2 ──────────────────────────────────────────────────────
  console.log('\nScenario 2: Simultaneous edits converge');
  {
    const d2 = (await api('POST', '/api/documents', { title: 'Conv' }, alice.token)).data;
    await api('POST', `/api/documents/${d2.id}/collaborators`, { userId: bob.user.id, role: 'editor' }, alice.token);

    const a = await connectWS(d2.id, alice.token);
    const b = await connectWS(d2.id, bob.token);
    await sleep(300);
    const dA = new Y.Doc(); const dB = new Y.Doc();
    sendSyncStep1(a.ws, dA); sendSyncStep1(b.ws, dB);
    await sleep(500);
    applySync(a.messages, dA); applySync(b.messages, dB);

    const aBefore = a.messages.length; const bBefore = b.messages.length;
    dA.getText('codemirror').insert(0, 'AAA');
    dB.getText('codemirror').insert(0, 'BBB');
    sendUpdate(a.ws, dA); sendUpdate(b.ws, dB);
    await sleep(1000);
    applySync(a.messages, dA, aBefore); applySync(b.messages, dB, bBefore);

    const tA = dA.getText('codemirror').toString();
    const tB = dB.getText('codemirror').toString();
    assert(tA === tB, `Both converge to same content: "${tA}" === "${tB}"`);
    assert(tA.includes('AAA') && tA.includes('BBB'), 'Both edits present');

    a.ws.close(); b.ws.close(); dA.destroy(); dB.destroy();
  }

  // ─── Scenario 3 ──────────────────────────────────────────────────────
  console.log('\nScenario 3: Viewer can read but cannot edit');
  {
    const d3 = (await api('POST', '/api/documents', { title: 'Viewer' }, alice.token)).data;
    await api('POST', `/api/documents/${d3.id}/collaborators`, { userId: carol.user.id, role: 'viewer' }, alice.token);

    const a = await connectWS(d3.id, alice.token);
    await sleep(200);
    const dA = new Y.Doc();
    sendSyncStep1(a.ws, dA); await sleep(200); applySync(a.messages, dA);
    dA.getText('codemirror').insert(0, 'Owner content');
    sendUpdate(a.ws, dA); await sleep(500);

    const c = await connectWS(d3.id, carol.token);
    await sleep(200);
    const dC = new Y.Doc();
    sendSyncStep1(c.ws, dC); await sleep(500); applySync(c.messages, dC);
    assert(dC.getText('codemirror').toString() === 'Owner content', 'Viewer receives existing content');

    const viewerDoc = new Y.Doc();
    viewerDoc.getText('codemirror').insert(0, 'viewer write');
    const upd = Y.encodeStateAsUpdate(viewerDoc);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, upd);
    c.ws.send(encoding.toUint8Array(enc));
    await sleep(500);

    const sDoc = docsMap.get(d3.id);
    const serverText = sDoc ? sDoc.getText('codemirror').toString() : '';
    assert(serverText === 'Owner content', `Server blocked viewer write (server text: "${serverText}")`);

    a.ws.close(); c.ws.close(); dA.destroy(); dC.destroy(); viewerDoc.destroy();
  }

  // ─── Scenario 4 ──────────────────────────────────────────────────────
  console.log('\nScenario 4: Editor can edit code but cannot manage collaborators or metadata');
  {
    const r1 = await api('POST', `/api/documents/${doc1.id}/collaborators`, { userId: dave.user.id, role: 'editor' }, bob.token);
    assert(r1.status === 403, `Editor cannot add collaborators (got ${r1.status})`);

    const r2 = await api('PUT', `/api/documents/${doc1.id}`, { title: 'Editor Title' }, bob.token);
    assert(r2.status === 404, `Editor cannot update metadata (got ${r2.status})`);

    const r3 = await api('PUT', `/api/documents/${doc1.id}`, { title: 'Owner Title' }, alice.token);
    assert(r3.status === 200, `Owner can update metadata (got ${r3.status})`);
  }

  // ─── Scenario 5 ──────────────────────────────────────────────────────
  console.log('\nScenario 5: Unauthenticated user cannot establish a WebSocket connection');
  {
    const r1 = await connectWSRaw(`ws://localhost:${PORT}/yjs/${doc1.id}`);
    assert(!r1.ws, `No ticket → rejected (statusCode: ${r1.statusCode})`);
    assert(r1.statusCode === 401, 'Returns 401 Unauthorized');

    const r2 = await connectWSRaw(`ws://localhost:${PORT}/yjs/${doc1.id}?ticket=invalid-ticket`);
    assert(!r2.ws, `Invalid ticket → rejected (statusCode: ${r2.statusCode})`);
    assert(r2.statusCode === 401, 'Returns 401 for invalid ticket');
  }

  // ─── Scenario 6 ──────────────────────────────────────────────────────
  console.log('\nScenario 6: Non-member cannot access a private document');
  {
    const ticketAttempt = await api('POST', `/api/documents/${doc1.id}/ws-ticket`, null, dave.token);
    assert(ticketAttempt.status === 403, `Dave (non-member) cannot get WS ticket (got ${ticketAttempt.status})`);

    const r2 = await api('GET', `/api/documents/${doc1.id}`, null, dave.token);
    assert(r2.status === 404, `REST API also denies access (got ${r2.status})`);
  }

  // ─── Scenario 7 ──────────────────────────────────────────────────────
  console.log('\nScenario 7: Late joiner receives existing document content');
  {
    const d7 = (await api('POST', '/api/documents', { title: 'Late' }, alice.token)).data;
    await api('POST', `/api/documents/${d7.id}/collaborators`, { userId: bob.user.id, role: 'editor' }, alice.token);

    const a = await connectWS(d7.id, alice.token);
    await sleep(200);
    const dA = new Y.Doc();
    sendSyncStep1(a.ws, dA); await sleep(200); applySync(a.messages, dA);
    dA.getText('codemirror').insert(0, 'Alice was here first');
    sendUpdate(a.ws, dA); await sleep(500);

    const b = await connectWS(d7.id, bob.token);
    await sleep(200);
    const dB = new Y.Doc();
    sendSyncStep1(b.ws, dB); await sleep(500); applySync(b.messages, dB);
    assert(dB.getText('codemirror').toString() === 'Alice was here first', `Late joiner got: "${dB.getText('codemirror')}"`);

    a.ws.close(); b.ws.close(); dA.destroy(); dB.destroy();
  }

  // ─── Scenario 8 ──────────────────────────────────────────────────────
  console.log('\nScenario 8: Live cursors and user presence');
  {
    const d8 = (await api('POST', '/api/documents', { title: 'Aware' }, alice.token)).data;
    await api('POST', `/api/documents/${d8.id}/collaborators`, { userId: bob.user.id, role: 'editor' }, alice.token);

    const a = await connectWS(d8.id, alice.token);
    const b = await connectWS(d8.id, bob.token);
    await sleep(300);

    const aDoc = new Y.Doc();
    const aAwareness = new awarenessProtocol.Awareness(aDoc);
    aAwareness.setLocalStateField('user', { name: 'alice', color: '#f00' });
    aAwareness.setLocalStateField('cursor', { anchor: 3, head: 7 });

    const awUpdate = awarenessProtocol.encodeAwarenessUpdate(aAwareness, [aDoc.clientID]);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awUpdate);
    a.ws.send(encoding.toUint8Array(enc));
    await sleep(500);

    const awMsgs = b.messages.filter((m) => {
      const d = decoding.createDecoder(m);
      return decoding.readVarUint(d) === MSG_AWARENESS;
    });
    assert(awMsgs.length >= 1, `Bob received ${awMsgs.length} awareness update(s)`);

    let users = [];
    for (const m of awMsgs) {
      const d = decoding.createDecoder(m);
      decoding.readVarUint(d);
      const data = decoding.readVarUint8Array(d);
      const tmp = new Y.Doc();
      const tmpAw = new awarenessProtocol.Awareness(tmp);
      awarenessProtocol.applyAwarenessUpdate(tmpAw, data, null);
      for (const [, s] of tmpAw.getStates()) {
        if (s.user) users.push(s.user.name);
      }
      tmp.destroy();
    }
    assert(users.length > 0, `Awareness contains user state (found ${users.length} user(s))`);
    console.log(`    Awareness users: ${JSON.stringify([...new Set(users)])}`);

    a.ws.close(); b.ws.close(); aDoc.destroy();
  }

  // ─── Scenario 9 ──────────────────────────────────────────────────────
  console.log('\nScenario 9: Reconnecting restores document content');
  {
    const d9 = (await api('POST', '/api/documents', { title: 'Recon' }, alice.token)).data;

    const a = await connectWS(d9.id, alice.token);
    await sleep(200);
    const dA = new Y.Doc();
    sendSyncStep1(a.ws, dA); await sleep(200); applySync(a.messages, dA);
    dA.getText('codemirror').insert(0, 'persistent data');
    sendUpdate(a.ws, dA); await sleep(3000);
    a.ws.close(); await sleep(1000);

    const a2 = await connectWS(d9.id, alice.token);
    await sleep(200);
    const dA2 = new Y.Doc();
    sendSyncStep1(a2.ws, dA2); await sleep(500); applySync(a2.messages, dA2);
    assert(dA2.getText('codemirror').toString() === 'persistent data', `Reconnected content: "${dA2.getText('codemirror')}"`);

    a2.ws.close(); dA.destroy(); dA2.destroy();
  }

  // ─── Scenario 10 ─────────────────────────────────────────────────────
  console.log('\nScenario 10: Content survives backend restart');
  {
    const d10 = (await api('POST', '/api/documents', { title: 'Restart' }, alice.token)).data;

    const a = await connectWS(d10.id, alice.token);
    await sleep(200);
    const dA = new Y.Doc();
    sendSyncStep1(a.ws, dA); await sleep(200); applySync(a.messages, dA);
    dA.getText('codemirror').insert(0, 'survives restart');
    sendUpdate(a.ws, dA); await sleep(3000);
    a.ws.close(); await sleep(1000);

    const row = await pool.query('SELECT yjs_state FROM documents WHERE id = $1', [d10.id]);
    assert(row.rows[0].yjs_state !== null, 'yjs_state saved to DB');

    const sDoc = docsMap.get(d10.id);
    if (sDoc) { docsMap.delete(d10.id); sDoc.destroy(); }

    const a2 = await connectWS(d10.id, alice.token);
    await sleep(200);
    const dA2 = new Y.Doc();
    sendSyncStep1(a2.ws, dA2); await sleep(500); applySync(a2.messages, dA2);
    assert(dA2.getText('codemirror').toString() === 'survives restart', `After restart: "${dA2.getText('codemirror')}"`);

    a2.ws.close(); dA.destroy(); dA2.destroy();
  }

  // ─── Scenario 11 ─────────────────────────────────────────────────────
  console.log('\nScenario 11: Multiple simultaneous connections share one Y.Doc');
  {
    const d11 = (await api('POST', '/api/documents', { title: 'Share' }, alice.token)).data;
    await api('POST', `/api/documents/${d11.id}/collaborators`, { userId: bob.user.id, role: 'editor' }, alice.token);

    const a = await connectWS(d11.id, alice.token);
    const b = await connectWS(d11.id, bob.token);
    await sleep(500);

    const sDoc = docsMap.get(d11.id);
    assert(sDoc !== undefined, 'Y.Doc exists in map');
    assert(sDoc.conns.size === 2, `One Y.Doc with ${sDoc.conns.size} connections (expected 2)`);

    let count = 0;
    for (const [k] of docsMap) { if (k === d11.id) count++; }
    assert(count === 1, `Exactly 1 Y.Doc instance in map for this docId`);

    a.ws.close(); b.ws.close();
  }

  // ─── Scenario 12 ─────────────────────────────────────────────────────
  console.log('\nScenario 12: Connection during idle cleanup is not lost');
  {
    const d12 = (await api('POST', '/api/documents', { title: 'CleanRace' }, alice.token)).data;
    await api('POST', `/api/documents/${d12.id}/collaborators`, { userId: bob.user.id, role: 'editor' }, alice.token);

    const a = await connectWS(d12.id, alice.token);
    await sleep(200);
    const dA = new Y.Doc();
    sendSyncStep1(a.ws, dA); await sleep(200); applySync(a.messages, dA);
    dA.getText('codemirror').insert(0, 'cleanup test data');
    sendUpdate(a.ws, dA); await sleep(500);

    a.ws.close();
    const b = await connectWS(d12.id, bob.token);
    await sleep(500);
    assert(b.ws.readyState === WebSocket.OPEN, `Bob connection is OPEN`);

    const dB = new Y.Doc();
    sendSyncStep1(b.ws, dB); await sleep(500); applySync(b.messages, dB);
    assert(dB.getText('codemirror').toString() === 'cleanup test data', `Bob got content after cleanup race: "${dB.getText('codemirror')}"`);

    dB.getText('codemirror').insert(0, 'Bob added: ');
    sendUpdate(b.ws, dB); await sleep(500);

    const sd = docsMap.get(d12.id);
    const st = sd ? sd.getText('codemirror').toString() : '';
    assert(st.includes('Bob added:'), `Bob's write was applied on server: "${st}"`);

    b.ws.close(); dA.destroy(); dB.destroy();
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
  console.log(failed === 0 ? 'All 12 scenarios passed.' : `${failed} FAILURE(S)`);

  docsMap.clear();
  server.close();
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
})();
