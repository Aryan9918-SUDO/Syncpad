require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { WebSocketServer } = require('ws');
const { setupWSConnection } = require('./services/yjs-server');
const { consumeTicket } = require('./services/ticket-store');
const pool = require('./config/db');

const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');

const app = express();

app.use(helmet());

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : undefined;

if (process.env.NODE_ENV === 'production' && !allowedOrigins) {
  console.error('FATAL: CORS_ORIGIN must be set in production');
  process.exit(1);
}

app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));

morgan.token('safe-url', (req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return url.pathname;
  } catch {
    return req.url;
  }
});
app.use(morgan(':method :safe-url :status :response-time ms'));

app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
});

app.use('/api/auth/register', authLimiter);
app.use('/api/auth/login', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

server.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/yjs\/(.+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    const docName = match[1];

    if (!UUID_RE.test(docName)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const ticketParam = url.searchParams.get('ticket');

    if (!ticketParam) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const entry = consumeTicket(ticketParam);
    if (!entry) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (entry.docId !== docName) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const { rows } = await pool.query(
      `SELECT d.owner_id, dc.role
       FROM documents d
       LEFT JOIN document_collaborators dc ON dc.document_id = d.id AND dc.user_id = $2
       WHERE d.id = $1`,
      [docName, entry.user.id]
    );

    if (rows.length === 0) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const isOwner = rows[0].owner_id === entry.user.id;
    const collabRole = rows[0].role;

    if (!isOwner && !collabRole) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const role = isOwner ? 'owner' : collabRole;

    wss.handleUpgrade(request, socket, head, (ws) => {
      setupWSConnection(ws, request, docName, entry.user, role);
    });
  } catch (err) {
    console.error('WebSocket upgrade error:', err.message);
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3001;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`SyncPad server running on port ${PORT}`);
  });
}

module.exports = { app, server };
