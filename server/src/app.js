require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const { WebSocketServer } = require('ws');
const { setupWSConnection } = require('./services/yjs-server');

const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  const match = pathname.match(/^\/yjs\/(.+)$/);

  if (match) {
    const docName = match[1];
    wss.handleUpgrade(request, socket, head, (ws) => {
      setupWSConnection(ws, request, docName);
    });
  } else {
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
