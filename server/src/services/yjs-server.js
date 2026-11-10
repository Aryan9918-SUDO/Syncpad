const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const pool = require('../config/db');

const wsReadyStateOpen = 1;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_ROLE_CHANGE = 2;

const WS_MSG_LIMIT = 300;
const WS_MSG_WINDOW_MS = 60000;

const docs = new Map();
const pending = new Map();

let _orphanTimeoutMs = 5 * 60 * 1000;

async function loadFromDB(docName) {
  const { rows } = await pool.query(
    'SELECT yjs_state FROM documents WHERE id = $1',
    [docName]
  );
  if (rows.length === 0) return { status: 'not_found' };
  if (rows[0].yjs_state) return { status: 'loaded', state: rows[0].yjs_state };
  return { status: 'empty' };
}

async function saveToDB(docName, doc) {
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  const { rowCount } = await pool.query(
    'UPDATE documents SET yjs_state = $1, updated_at = NOW() WHERE id = $2',
    [state, docName]
  );
  if (rowCount === 0) {
    const err = new Error(`Document ${docName} no longer exists in database`);
    err.code = 'DOC_DELETED';
    throw err;
  }
}

async function getYDoc(docName) {
  if (docs.has(docName)) return docs.get(docName);
  if (pending.has(docName)) return pending.get(docName);

  const loadPromise = (async () => {
    const result = await loadFromDB(docName);

    if (result.status === 'not_found') {
      throw new Error('DOCUMENT_NOT_FOUND');
    }

    const doc = new Y.Doc();
    doc.name = docName;
    doc.conns = new Map();
    doc.awareness = new awarenessProtocol.Awareness(doc);
    doc.awareness.setLocalState(null);
    doc._saveTimeout = null;
    doc._orphanTimeout = null;

    if (result.status === 'loaded') {
      Y.applyUpdate(doc, new Uint8Array(result.state));
    }

    doc.on('update', (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      doc.conns.forEach((connMeta, conn) => {
        if (conn !== origin) {
          send(doc, conn, message);
        }
      });

      clearTimeout(doc._saveTimeout);
      doc._saveTimeout = setTimeout(() => {
        saveToDB(docName, doc).catch((err) => {
          console.error(`Save failed for ${docName}:`, err.message);
        });
      }, 2000);
    });

    doc.awareness.on('update', ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed);
      if (conn !== null) {
        const connMeta = doc.conns.get(conn);
        if (connMeta !== undefined) {
          added.forEach((clientId) => connMeta.controlledIds.add(clientId));
          removed.forEach((clientId) => connMeta.controlledIds.delete(clientId));
        }
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(doc.awareness, changedClients)
      );
      const message = encoding.toUint8Array(encoder);
      doc.conns.forEach((_, c) => send(doc, c, message));
    });

    docs.set(docName, doc);
    return doc;
  })();

  pending.set(docName, loadPromise);
  try {
    return await loadPromise;
  } finally {
    pending.delete(docName);
  }
}

function sanitizeAwarenessUpdate(updateData, conn, doc) {
  const connMeta = doc.conns.get(conn);
  if (!connMeta) return null;

  const decoder = decoding.createDecoder(updateData);
  const count = decoding.readVarUint(decoder);
  const entries = [];

  for (let i = 0; i < count; i++) {
    const clientID = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const stateStr = decoding.readVarString(decoder);

    let ownedByOther = false;
    for (const [otherConn, otherMeta] of doc.conns) {
      if (otherConn !== conn && otherMeta.controlledIds.has(clientID)) {
        ownedByOther = true;
        break;
      }
    }
    if (ownedByOther) continue;

    if (stateStr.length > 0) {
      try {
        const state = JSON.parse(stateStr);
        if (state !== null && typeof state === 'object' && !Array.isArray(state)) {
          if (state.user !== undefined) {
            if (typeof state.user === 'object' && state.user !== null && !Array.isArray(state.user)) {
              state.user.name = connMeta.user.username;
            } else {
              state.user = { name: connMeta.user.username };
            }
          }
          entries.push({ clientID, clock, stateStr: JSON.stringify(state) });
        }
      } catch {
        // Malformed JSON: drop the entry
      }
    } else {
      entries.push({ clientID, clock, stateStr });
    }
  }

  if (entries.length === 0) return null;

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientID);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.stateStr);
  }
  return encoding.toUint8Array(encoder);
}

function send(doc, conn, message) {
  if (conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn);
    return;
  }
  try {
    conn.send(message, (err) => {
      if (err) closeConn(doc, conn);
    });
  } catch (_err) {
    closeConn(doc, conn);
  }
}

function closeConn(doc, conn) {
  if (doc.conns.has(conn)) {
    const connMeta = doc.conns.get(conn);
    doc.conns.delete(conn);

    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(connMeta.controlledIds),
      null
    );

    if (doc.conns.size === 0) {
      cleanupDoc(doc.name, doc);
    }
  }
  conn.close();
}

async function cleanupDoc(docName, doc) {
  clearTimeout(doc._saveTimeout);
  clearTimeout(doc._orphanTimeout);

  let saved = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (doc.conns.size > 0) return;
    try {
      await saveToDB(docName, doc);
      saved = true;
      break;
    } catch (err) {
      console.error(`Cleanup save attempt ${attempt + 1}/3 failed for ${docName}:`, err.message);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  if (doc.conns.size > 0) return;

  if (saved) {
    if (docs.get(docName) === doc) docs.delete(docName);
    doc.destroy();
    return;
  }

  console.error(`Retaining ${docName} in memory after failed save`);
  scheduleOrphanRetry(docName, doc, 0);
}

function scheduleOrphanRetry(docName, doc, attempt) {
  const maxDelay = 5 * _orphanTimeoutMs;
  const delay = Math.min(_orphanTimeoutMs * Math.pow(2, attempt), maxDelay);
  doc._orphanTimeout = setTimeout(() => {
    if (doc.conns.size > 0) return;
    saveToDB(docName, doc)
      .then(() => {
        if (doc.conns.size === 0 && docs.get(docName) === doc) {
          docs.delete(docName);
          doc.destroy();
        }
      })
      .catch((err) => {
        if (err.code === 'DOC_DELETED') {
          if (doc.conns.size === 0 && docs.get(docName) === doc) {
            docs.delete(docName);
            doc.destroy();
          }
        } else {
          console.error(`Orphan retry ${attempt + 1} for ${docName} failed:`, err.message);
          if (doc.conns.size === 0 && docs.get(docName) === doc) {
            scheduleOrphanRetry(docName, doc, attempt + 1);
          }
        }
      });
  }, delay);
}

function handleMessage(conn, doc, message) {
  try {
    const connMeta = doc.conns.get(conn);
    if (!connMeta) return;
    const { role } = connMeta;

    const now = Date.now();
    if (now - connMeta.msgWindowStart > WS_MSG_WINDOW_MS) {
      connMeta.msgCount = 0;
      connMeta.msgWindowStart = now;
    }
    if (++connMeta.msgCount > WS_MSG_LIMIT) {
      // 4429: y-websocket reconnects on all close codes with exponential backoff
      conn.close(4429, 'Rate limit exceeded');
      return;
    }

    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MSG_SYNC: {
        const syncType = decoding.readVarUint(decoder);

        if (role === 'viewer' && syncType !== syncProtocol.messageYjsSyncStep1) {
          return;
        }

        encoding.writeVarUint(encoder, MSG_SYNC);
        switch (syncType) {
          case syncProtocol.messageYjsSyncStep1:
            syncProtocol.readSyncStep1(decoder, encoder, doc);
            break;
          case syncProtocol.messageYjsSyncStep2:
            syncProtocol.readSyncStep2(decoder, doc, conn);
            break;
          case syncProtocol.messageYjsUpdate:
            syncProtocol.readUpdate(decoder, doc, conn);
            break;
          default:
            throw new Error('Unknown sync message type');
        }
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      }
      case MSG_AWARENESS: {
        const rawUpdate = decoding.readVarUint8Array(decoder);
        const sanitized = sanitizeAwarenessUpdate(rawUpdate, conn, doc);
        if (sanitized) {
          awarenessProtocol.applyAwarenessUpdate(doc.awareness, sanitized, conn);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Yjs message error:', err);
  }
}

async function setupWSConnection(conn, req, docName, user, role) {
  conn.binaryType = 'arraybuffer';

  const messageQueue = [];
  let docReady = false;
  let doc = null;
  let closed = false;

  conn.on('message', (message) => {
    if (!docReady) {
      messageQueue.push(new Uint8Array(message));
      return;
    }
    handleMessage(conn, doc, new Uint8Array(message));
  });

  conn.on('close', () => {
    closed = true;
    if (docReady && doc) {
      closeConn(doc, conn);
    }
  });

  try {
    doc = await getYDoc(docName);
  } catch (err) {
    if (err.message === 'DOCUMENT_NOT_FOUND') {
      conn.close(4404, 'Document not found');
    } else {
      console.error(`Failed to load doc ${docName}:`, err.message);
      conn.close(4500, 'Server error');
    }
    return;
  }

  if (closed || conn.readyState !== wsReadyStateOpen) return;

  doc.conns.set(conn, {
    controlledIds: new Set(),
    role,
    user,
    msgCount: 0,
    msgWindowStart: Date.now(),
  });
  docReady = true;

  clearTimeout(doc._orphanTimeout);

  for (const msg of messageQueue) {
    if (conn.readyState !== wsReadyStateOpen) break;
    handleMessage(conn, doc, msg);
  }

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  send(doc, conn, encoding.toUint8Array(encoder));

  const awarenessStates = doc.awareness.getStates();
  if (awarenessStates.size > 0) {
    const encoder2 = encoding.createEncoder();
    encoding.writeVarUint(encoder2, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      encoder2,
      awarenessProtocol.encodeAwarenessUpdate(
        doc.awareness,
        Array.from(awarenessStates.keys())
      )
    );
    send(doc, conn, encoding.toUint8Array(encoder2));
  }
}

function destroyDoc(docName) {
  const doc = docs.get(docName);
  if (!doc) return;

  clearTimeout(doc._orphanTimeout);
  doc.conns.forEach((_, conn) => {
    conn.close(4410, 'Document deleted');
  });
  doc.conns.clear();

  clearTimeout(doc._saveTimeout);
  docs.delete(docName);
  doc.destroy();
}

function disconnectUser(docName, userId) {
  const doc = docs.get(docName);
  if (!doc) return;
  for (const [conn, meta] of doc.conns) {
    if (meta.user.id === userId) {
      conn.close(4403, 'Access revoked');
    }
  }
}

function updateConnRole(docName, userId, newRole) {
  const doc = docs.get(docName);
  if (!doc) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_ROLE_CHANGE);
  encoding.writeVarString(encoder, newRole);
  const message = encoding.toUint8Array(encoder);
  for (const [conn, meta] of doc.conns) {
    if (meta.user.id === userId) {
      meta.role = newRole;
      send(doc, conn, message);
    }
  }
}

module.exports = {
  setupWSConnection, getYDoc, docs, destroyDoc,
  disconnectUser, updateConnRole,
  _setOrphanTimeoutMs(ms) { _orphanTimeoutMs = ms; },
};
