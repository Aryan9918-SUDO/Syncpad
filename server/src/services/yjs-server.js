const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const pool = require('../config/db');

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const docs = new Map();

async function loadFromDB(docName) {
  try {
    const { rows } = await pool.query(
      'SELECT yjs_state FROM documents WHERE id = $1',
      [docName]
    );
    if (rows.length > 0 && rows[0].yjs_state) {
      return rows[0].yjs_state;
    }
  } catch (err) {
    console.error('Failed to load Yjs state from DB:', err.message);
  }
  return null;
}

async function saveToDB(docName, doc) {
  try {
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));
    await pool.query(
      'UPDATE documents SET yjs_state = $1, updated_at = NOW() WHERE id = $2',
      [state, docName]
    );
  } catch (err) {
    console.error('Failed to save Yjs state to DB:', err.message);
  }
}

async function getYDoc(docName) {
  if (docs.has(docName)) return docs.get(docName);

  const doc = new Y.Doc();
  doc.name = docName;
  doc.conns = new Map();
  doc.awareness = new awarenessProtocol.Awareness(doc);
  doc.awareness.setLocalState(null);

  const saved = await loadFromDB(docName);
  if (saved) {
    Y.applyUpdate(doc, new Uint8Array(saved));
  }

  doc.on('update', () => {
    clearTimeout(doc._saveTimeout);
    doc._saveTimeout = setTimeout(() => saveToDB(docName, doc), 2000);
  });

  doc.awareness.on('update', ({ added, updated, removed }, conn) => {
    const changedClients = added.concat(updated, removed);
    if (conn !== null) {
      const connControlledIds = doc.conns.get(conn);
      if (connControlledIds !== undefined) {
        added.forEach((clientId) => connControlledIds.add(clientId));
        removed.forEach((clientId) => connControlledIds.delete(clientId));
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

  doc.on('idle', async () => {
    await saveToDB(docName, doc);
    docs.delete(docName);
    doc.destroy();
  });

  docs.set(docName, doc);
  return doc;
}

function send(doc, conn, message) {
  if (
    conn.readyState !== wsReadyStateConnecting &&
    conn.readyState !== wsReadyStateOpen
  ) {
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
    const controlledIds = doc.conns.get(conn);
    doc.conns.delete(conn);

    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(controlledIds),
      null
    );

    if (doc.conns.size === 0) {
      doc.emit('idle', []);
    }
  }
  conn.close();
}

function handleMessage(conn, doc, message) {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MSG_SYNC:
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
        break;
    }
  } catch (err) {
    console.error('Yjs message error:', err);
    doc.emit('error', [err]);
  }
}

async function setupWSConnection(conn, req, docName) {
  conn.binaryType = 'arraybuffer';
  const doc = await getYDoc(docName);
  doc.conns.set(conn, new Set());

  conn.on('message', (message) => {
    handleMessage(conn, doc, new Uint8Array(message));
  });

  conn.on('close', () => {
    closeConn(doc, conn);
  });

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

module.exports = { setupWSConnection, getYDoc, docs };
