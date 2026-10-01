# SyncPad

> A real-time collaborative code editor where multiple users edit the same document simultaneously with **zero conflicts**. Built on **Yjs CRDTs** (Conflict-free Replicated Data Types) — every client maintains a local document replica, and edits merge automatically without a central authority. The server is a relay, not an arbiter. Documents persist to PostgreSQL as serialized binary state, surviving server restarts. Supports live cursors, presence awareness, multi-language syntax highlighting, and document sharing with role-based access.

![CI](https://img.shields.io/badge/CI-passing-brightgreen)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)
![Tests](https://img.shields.io/badge/tests-24%20passing-brightgreen)
![ESLint](https://img.shields.io/badge/ESLint%209-passing-4B32C3?logo=eslint)
![License](https://img.shields.io/badge/license-MIT-blue)

**Author:** [Aryan Kumar Singh](https://github.com/Aryan9918-SUDO)

**Stack:** Node.js 18, Express 5, PostgreSQL 15, Yjs (CRDT), CodeMirror 6, React 18, Vite 5, WebSocket (ws), JWT + bcryptjs, Jest 29, Supertest, ESLint 9 (flat config), GitHub Actions, Docker Compose

---

## Highlights (why this is more than a demo)

- **Production-grade CRDT sync** — not a toy WebSocket broadcast; uses the full Yjs protocol (sync + awareness) with binary-encoded state vectors, incremental updates, and client-server state reconciliation
- **Custom Yjs server** — hand-built on top of `y-protocols` and `lib0`, not a wrapper around `y-websocket-server`. Shares the same HTTP port as Express, enables per-document access control, and handles connection lifecycle (join, sync, disconnect, cleanup)
- **Persistent CRDT state** — Yjs documents serialize to PostgreSQL as `BYTEA` with a 2-second debounced write + flush-on-idle. New clients load the full document state from DB, so content survives server restarts and zero-client windows
- **Hot language switching** — CodeMirror 6 compartments allow reconfiguring the syntax mode (JS, Python, HTML, CSS, JSON) without destroying and rebuilding the editor state or losing cursor position
- **Awareness protocol** — live cursor positions, selections, and user identity broadcast to all peers via the Yjs awareness channel. Each user gets a deterministic color based on their username hash
- **Software engineering practices** — 24 integration tests hitting a real database (not mocks), ESLint 9 flat config, GitHub Actions CI with 3 parallel jobs (lint, test with Postgres service container, client production build)
- **Full auth + sharing flow** — JWT register/login, document CRUD, owner-managed collaborator list with user search, role-based access checks on every API endpoint

---

## Architecture

### System Overview

```mermaid
graph TB
    subgraph Client ["Client (React + Vite, port 5173)"]
        UI[Auth / Dashboard UI]
        CM[CodeMirror 6 Editor<br/>One Dark theme]
        YB[Yjs Bindings<br/>y-codemirror.next]
        YD[Local Yjs Document<br/>Y.Text type]
        AW[Awareness State<br/>cursor + user info]
    end

    subgraph Server ["Server (Node.js + Express, port 3001)"]
        REST[REST API<br/>Auth / Documents / Share]
        WSS[WebSocket Server<br/>noServer mode]
        YJS[Yjs Sync Service<br/>y-protocols + lib0]
        DOC[In-Memory Doc Map<br/>Map&lt;docId, Y.Doc&gt;]
        JWT[JWT Middleware<br/>jsonwebtoken + bcryptjs]
    end

    subgraph Storage ["PostgreSQL 15"]
        USERS[(users<br/>id, username, email, password_hash)]
        DOCS[(documents<br/>id, title, language, owner_id, yjs_state)]
        COLLAB[(document_collaborators<br/>document_id, user_id, role)]
    end

    UI -- "HTTP (fetch)" --> REST
    REST -- "verify token" --> JWT
    REST -- "SQL queries" --> USERS
    REST -- "SQL queries" --> DOCS
    REST -- "SQL queries" --> COLLAB

    CM -- "keystrokes" --> YB
    YB -- "Y.Text ops" --> YD
    YD -- "binary updates" --> AW
    AW -- "WebSocket<br/>/yjs/:docId" --> WSS
    WSS -- "handleUpgrade" --> YJS
    YJS -- "sync protocol" --> DOC
    DOC -- "debounced save<br/>(2s + flush on idle)" --> DOCS

    style Client fill:#1e1e2e,stroke:#cba6f7,color:#cdd6f4
    style Server fill:#181825,stroke:#89b4fa,color:#cdd6f4
    style Storage fill:#181825,stroke:#a6e3a1,color:#cdd6f4
```

### How CRDT Sync Works (step by step)

```mermaid
sequenceDiagram
    participant C1 as Client A
    participant S as Server (Yjs)
    participant DB as PostgreSQL
    participant C2 as Client B

    Note over S,DB: Client A opens document
    C1->>S: WebSocket connect /yjs/:docId
    S->>DB: SELECT yjs_state WHERE id = :docId
    DB-->>S: Binary state (or null)
    S->>S: Y.applyUpdate(doc, savedState)
    S->>C1: SyncStep1 (state vector)
    C1->>S: SyncStep2 (missing updates)
    S->>C1: SyncStep2 (server's missing updates)
    Note over C1: Document loaded + synced

    Note over S: Client B joins same document
    C2->>S: WebSocket connect /yjs/:docId
    S->>C2: SyncStep1 + Awareness states
    C2->>S: SyncStep2
    Note over C2: Document loaded + sees Client A's cursor

    Note over C1,C2: Both clients type simultaneously
    C1->>S: Update (binary CRDT ops)
    S->>C2: Broadcast update
    C2->>S: Update (binary CRDT ops)
    S->>C1: Broadcast update
    Note over C1,C2: CRDTs merge automatically — no conflicts

    S->>DB: UPDATE yjs_state (debounced 2s)

    Note over C1: Client A disconnects
    C1->>S: WebSocket close
    S->>S: Remove awareness state
    S->>C2: Awareness update (A left)

    Note over C2: Client B disconnects (last client)
    C2->>S: WebSocket close
    S->>DB: Final flush — UPDATE yjs_state
    S->>S: Destroy Y.Doc, free memory
```

### Key Design Decisions

| Decision | Alternative | Why this choice |
|----------|-----------|-----------------|
| **Yjs CRDTs** over Operational Transformation | OT (Google Docs approach) | CRDTs guarantee convergence without server-side transform logic. The server is stateless — it relays binary messages. No coordination, no conflict resolution code, no version vectors to maintain |
| **Custom Yjs server** over `y-websocket` CLI | `npx y-websocket` as a separate process | Sharing the same HTTP server means one port, one process, and the ability to add auth middleware to WebSocket upgrades. Also enables direct DB persistence from the sync service |
| **PostgreSQL BYTEA** over file-system snapshots | Write Yjs state to `.yjs` files on disk | DB storage is atomic, queryable (JOIN with documents table), and works in containerized/ephemeral environments. BYTEA handles binary efficiently |
| **Debounced + flush-on-idle** persistence | Save on every update / Save on disconnect only | Every-update is too expensive (hundreds of writes per minute during active editing). Disconnect-only risks data loss on crashes. 2-second debounce + flush when the last client leaves balances both |
| **CodeMirror 6 Compartments** for language switching | Destroy and recreate EditorView | Compartments reconfigure a single extension slot without losing editor state, cursor position, undo history, or Yjs binding. Destroying the view would disconnect the CRDT |
| **JWT in Authorization header** (not cookies) | Session cookies | Stateless auth for the REST API. The WebSocket connection is opened by client-side code that already has the token — no cookie-based CORS complexity |

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Editor | CodeMirror 6 + One Dark theme | Code editing with syntax highlighting, line numbers, bracket matching |
| CRDT Engine | Yjs 13 | Conflict-free replicated data types for real-time merge |
| Editor Binding | y-codemirror.next | Binds Yjs Y.Text to CodeMirror EditorState |
| WebSocket Client | y-websocket | Client-side Yjs WebSocket provider + awareness |
| Frontend | React 18, Vite 5 | SPA with HMR, dev proxy for API + WebSocket |
| Backend | Node.js 18, Express 5 | REST API + HTTP server for WebSocket upgrade |
| WebSocket Server | ws 8 | Low-level WebSocket with `noServer` mode for custom upgrade |
| Sync Protocol | y-protocols, lib0 | Binary encoding/decoding for Yjs sync and awareness messages |
| Database | PostgreSQL 15 | Users, documents, collaborators, serialized CRDT state |
| Auth | jsonwebtoken + bcryptjs | JWT token signing/verification, password hashing |
| Testing | Jest 29 + Supertest 7 | Integration tests against real PostgreSQL |
| Linting | ESLint 9 (flat config) | Code quality with unused-var patterns for catch/args |
| CI/CD | GitHub Actions | 3 parallel jobs: lint, test (with Postgres service), client build |
| Containerization | Docker Compose | PostgreSQL service for local development |

---

## Features

| Feature | Implementation |
|---------|---------------|
| Real-time collaboration | Yjs CRDT with binary sync protocol over WebSocket |
| Live cursors & presence | Yjs awareness protocol — cursor position, selection, username, color |
| Multi-language syntax | CodeMirror 6 language packages (JS, Python, HTML, CSS, JSON) |
| Hot language switching | CodeMirror Compartment reconfiguration without editor rebuild |
| Document persistence | Yjs state → `BYTEA` in PostgreSQL (2s debounce + flush on idle) |
| User authentication | JWT register/login, bcrypt password hashing, token-gated routes |
| Document sharing | Owner adds/removes collaborators by searching users, role-based access |
| Dark theme | Catppuccin Mocha-inspired palette with CodeMirror One Dark |

---

## Database Schema

```sql
-- Users table
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(50) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Documents table (yjs_state stores the full CRDT document as binary)
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           VARCHAR(255) NOT NULL DEFAULT 'Untitled',
    language        VARCHAR(50) NOT NULL DEFAULT 'javascript',
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    yjs_state       BYTEA,                    -- serialized Yjs document
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Many-to-many: which users can access which documents
CREATE TABLE document_collaborators (
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL DEFAULT 'editor',
    added_at        TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (document_id, user_id)
);

CREATE INDEX idx_documents_owner ON documents(owner_id);
CREATE INDEX idx_collaborators_user ON document_collaborators(user_id);
```

---

## REST API

Start the server: `cd server && npm run dev`

### Authentication

| Method | Endpoint | Auth | Request Body | Response |
|--------|----------|------|-------------|----------|
| POST | `/api/auth/register` | No | `{username, email, password}` | `{user, token}` |
| POST | `/api/auth/login` | No | `{email, password}` | `{user, token}` |
| GET | `/api/auth/me` | Bearer | — | `{id, username, email, created_at}` |

### Documents

| Method | Endpoint | Auth | Request Body | Response |
|--------|----------|------|-------------|----------|
| POST | `/api/documents` | Bearer | `{title?, language?}` | Created document |
| GET | `/api/documents` | Bearer | — | Array of owned + shared docs |
| GET | `/api/documents/:id` | Bearer | — | Single document |
| PUT | `/api/documents/:id` | Bearer | `{title?, language?}` | Updated document |
| DELETE | `/api/documents/:id` | Bearer | — | 204 No Content |

### Collaboration

| Method | Endpoint | Auth | Request Body | Response |
|--------|----------|------|-------------|----------|
| GET | `/api/documents/search-users?q=` | Bearer | — | Array of matching users |
| POST | `/api/documents/:id/collaborators` | Bearer | `{userId, role?}` | 201 Created |
| GET | `/api/documents/:id/collaborators` | Bearer | — | Array of collaborators |
| DELETE | `/api/documents/:id/collaborators/:userId` | Bearer | — | 204 No Content |

### WebSocket

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `ws://localhost:3001/yjs/:documentId` | Yjs sync + awareness | Binary CRDT sync channel |

### Example: Register + Create Document + Connect

```bash
# Register a user
curl -s -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com","password":"secret123"}'
# → {"user":{"id":"...","username":"alice","email":"alice@example.com"},"token":"eyJ..."}

# Create a document
TOKEN="eyJ..."  # from the register response
curl -s -X POST http://localhost:3001/api/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"My First Doc","language":"javascript"}'
# → {"id":"...","title":"My First Doc","language":"javascript","owner_id":"..."}

# Connect to the CRDT sync channel (use wscat or the browser client)
# wscat -c ws://localhost:3001/yjs/<document-id>
```

---

## Quickstart

### Prerequisites

- **Node.js 18+** (`node --version`)
- **PostgreSQL 15+** — via Docker (recommended) or local install

### Setup

```bash
# 1. Clone
git clone https://github.com/Aryan9918-SUDO/SyncPad.git
cd SyncPad

# 2. Start PostgreSQL
docker compose up -d

# 3. Server
cd server
cp .env.example .env
npm install
npm run db:init          # creates tables
npm run dev              # http://localhost:3001

# 4. Client (new terminal)
cd client
npm install
npm run dev              # http://localhost:5173
```

Open `http://localhost:5173` — register an account, create a document, start typing. Open a **second browser tab** with the same document to see real-time collaboration in action.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Express server port |
| `DATABASE_URL` | — | PostgreSQL connection string (e.g., `postgresql://postgres:postgres@localhost:5432/syncpad`) |
| `JWT_SECRET` | — | Secret key for signing/verifying JWT tokens. Use a random string in production |

See [`server/.env.example`](server/.env.example) for a working local configuration.

---

## Run with Docker

```bash
# Start PostgreSQL + initialize schema
docker compose up -d
cd server && npm run db:init

# Or run everything manually
docker run -d --name syncpad-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=syncpad \
  -p 5432:5432 \
  postgres:15-alpine
```

---

## Testing, Quality & CI

### Tests (24 integration tests, real PostgreSQL)

```bash
cd server
npm test                 # Run all tests
npm run test:coverage    # With coverage report
```

| Suite | Tests | What's covered |
|-------|-------|----------------|
| `auth.test.js` | 9 | Register (success, duplicate, missing fields), Login (success, wrong password, non-existent), Profile (valid token, missing token, invalid token) |
| `documents.test.js` | 15 | Create (with values, defaults, unauth), List, Get (found, 404), Update (title, language), Delete (success, already deleted), Add/list/remove collaborators, User search |

### Linting

```bash
npm run lint             # ESLint 9 flat config
```

### CI Pipeline (GitHub Actions)

Three parallel jobs on every push/PR to `main`:

| Job | What it does |
|-----|-------------|
| `server-lint` | `npm ci` → `npm run lint` |
| `server-test` | Spins up Postgres 15 service container → `npm ci` → `node src/config/init-db.js` → `npm test` |
| `client-build` | `npm ci` → `npx vite build` (catches import errors, type mismatches, dead code) |

---

## Project Structure

```
SyncPad/
├── client/                              # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── AuthForm.jsx             # Login/register toggle form
│   │   │   ├── Dashboard.jsx            # Document list + create new doc
│   │   │   ├── Editor.jsx               # CodeMirror 6 + Yjs CRDT binding + language switch
│   │   │   └── SharePanel.jsx           # User search + add/remove collaborators
│   │   ├── App.jsx                      # Root: auth state → landing / dashboard / editor
│   │   ├── index.css                    # Global styles (Catppuccin Mocha palette)
│   │   └── main.jsx                     # ReactDOM entry point
│   ├── index.html                       # Vite HTML entry
│   ├── vite.config.js                   # Dev server proxy: /api → :3001, /yjs → ws://:3001
│   └── package.json                     # React, CodeMirror, Yjs, Vite deps
│
├── server/                              # Node.js backend
│   ├── src/
│   │   ├── config/
│   │   │   ├── db.js                    # PostgreSQL connection pool (pg)
│   │   │   └── init-db.js              # Schema migration: users, documents, collaborators
│   │   ├── controllers/
│   │   │   ├── auth.js                  # register, login, me — bcrypt + JWT
│   │   │   └── documents.js             # CRUD + collaborators + user search (ILIKE)
│   │   ├── middleware/
│   │   │   └── auth.js                  # JWT verify + signToken helper
│   │   ├── routes/
│   │   │   ├── auth.js                  # POST register/login, GET me
│   │   │   └── documents.js             # Full document + collaborator routes
│   │   ├── services/
│   │   │   └── yjs-server.js            # Core: Yjs sync protocol, awareness, DB load/save
│   │   └── app.js                       # Express app + HTTP server + WebSocket upgrade handler
│   ├── tests/
│   │   ├── auth.test.js                 # 9 auth integration tests
│   │   └── documents.test.js            # 15 document + collab integration tests
│   ├── .env.example                     # Template env vars
│   ├── eslint.config.js                 # ESLint 9 flat config with Jest globals
│   └── package.json                     # Express, Yjs, ws, pg, Jest, Supertest deps
│
├── .github/workflows/ci.yml            # GitHub Actions: lint + test + build (3 parallel jobs)
├── .gitignore                           # node_modules, dist, .env, coverage, .vite
├── docker-compose.yml                   # PostgreSQL 15 Alpine service
└── README.md
```

---

## Known Limits

- **No authentication on WebSocket** — the `/yjs/:docId` channel currently accepts any connection. Production would need token validation on the upgrade request before establishing the sync
- **No rate limiting** — API endpoints are unprotected against brute-force login or document spam
- **Single-server only** — the in-memory `Map<docId, Y.Doc>` doesn't synchronize across multiple server instances. Horizontal scaling would need Redis pub/sub or a shared Yjs persistence layer
- **No undo/redo across sessions** — Yjs undo manager is per-client and not persisted. Closing and reopening a document starts a fresh undo stack
- **Client bundle size** — CodeMirror 6 + Yjs + 5 language packs produce an ~870 KB bundle. Code splitting with dynamic imports would reduce initial load

---

## License

MIT — see [LICENSE](LICENSE)
