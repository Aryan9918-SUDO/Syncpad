const pool = require('../config/db');
const { destroyDoc, disconnectUser, updateConnRole } = require('../services/yjs-server');
const { createTicket, invalidateTicketsForUser } = require('../services/ticket-store');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = ['editor', 'viewer'];
const VALID_LANGUAGES = ['javascript', 'python', 'html', 'css', 'json'];

const DOC_COLUMNS = 'id, title, language, owner_id, created_at, updated_at';

async function createDocument(req, res) {
  const { title, language } = req.body;

  if (title !== undefined && (typeof title !== 'string' || title.length > 255)) {
    return res.status(400).json({ error: 'Title must be a string under 255 characters' });
  }
  if (language !== undefined && !VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({ error: `Language must be one of: ${VALID_LANGUAGES.join(', ')}` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO documents (title, language, owner_id) VALUES ($1, $2, $3) RETURNING ${DOC_COLUMNS}`,
      [title || 'Untitled', language || 'javascript', req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to create document' });
  }
}

async function listDocuments(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT ${DOC_COLUMNS},
        CASE WHEN d.owner_id = $1 THEN 'owner'
             WHEN dc.role IS NOT NULL THEN dc.role
        END AS role
       FROM documents d
       LEFT JOIN document_collaborators dc ON dc.document_id = d.id AND dc.user_id = $1
       WHERE d.owner_id = $1 OR dc.user_id = $1
       ORDER BY d.updated_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to list documents' });
  }
}

async function getDocument(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid document ID' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT ${DOC_COLUMNS},
        CASE WHEN d.owner_id = $2 THEN 'owner'
             WHEN dc.role IS NOT NULL THEN dc.role
        END AS role
       FROM documents d
       LEFT JOIN document_collaborators dc ON dc.document_id = d.id AND dc.user_id = $2
       WHERE d.id = $1 AND (d.owner_id = $2 OR dc.user_id = $2)`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to fetch document' });
  }
}

async function updateDocument(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid document ID' });
  }
  const { title, language } = req.body;

  if (title !== undefined && (typeof title !== 'string' || title.length > 255 || title.trim().length === 0)) {
    return res.status(400).json({ error: 'Title must be a non-empty string under 255 characters' });
  }
  if (language !== undefined && !VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({ error: `Language must be one of: ${VALID_LANGUAGES.join(', ')}` });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE documents SET title = COALESCE($1, title), language = COALESCE($2, language), updated_at = NOW()
       WHERE id = $3 AND owner_id = $4 RETURNING ${DOC_COLUMNS}`,
      [title, language, req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to update document' });
  }
}

async function deleteDocument(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid document ID' });
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM documents WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Document not found' });

    destroyDoc(req.params.id);

    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Failed to delete document' });
  }
}

async function addCollaborator(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid document ID' });
  }
  const { userId, role } = req.body;

  if (!userId || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Valid userId is required' });
  }

  const effectiveRole = role || 'editor';
  if (!VALID_ROLES.includes(effectiveRole)) {
    return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  try {
    const docCheck = await pool.query('SELECT owner_id FROM documents WHERE id = $1', [req.params.id]);
    if (docCheck.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    if (docCheck.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the owner can add collaborators' });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot add yourself as collaborator' });
    }

    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query(
      'INSERT INTO document_collaborators (document_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (document_id, user_id) DO UPDATE SET role = $3',
      [req.params.id, userId, effectiveRole]
    );
    updateConnRole(req.params.id, userId, effectiveRole);
    res.status(201).json({ message: 'Collaborator added' });
  } catch {
    res.status(500).json({ error: 'Failed to add collaborator' });
  }
}

async function getCollaborators(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid document ID' });
  }
  try {
    const accessCheck = await pool.query(
      `SELECT d.owner_id, dc.role FROM documents d
       LEFT JOIN document_collaborators dc ON dc.document_id = d.id AND dc.user_id = $2
       WHERE d.id = $1`,
      [req.params.id, req.user.id]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    if (accessCheck.rows[0].owner_id !== req.user.id && !accessCheck.rows[0].role) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.email, dc.role FROM document_collaborators dc
       JOIN users u ON u.id = dc.user_id
       WHERE dc.document_id = $1`,
      [req.params.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch collaborators' });
  }
}

async function removeCollaborator(req, res) {
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.userId)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }
  try {
    const docCheck = await pool.query('SELECT owner_id FROM documents WHERE id = $1', [req.params.id]);
    if (docCheck.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    if (docCheck.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the owner can remove collaborators' });
    }

    await pool.query(
      'DELETE FROM document_collaborators WHERE document_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    disconnectUser(req.params.id, req.params.userId);
    invalidateTicketsForUser(req.params.id, req.params.userId);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Failed to remove collaborator' });
  }
}

async function searchUsers(req, res) {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT id, username, email FROM users WHERE (username ILIKE $1 OR email ILIKE $1) AND id != $2 LIMIT 10',
      [`%${q}%`, req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Search failed' });
  }
}

async function createWSTicket(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid document ID' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT d.owner_id, dc.role
       FROM documents d
       LEFT JOIN document_collaborators dc ON dc.document_id = d.id AND dc.user_id = $2
       WHERE d.id = $1`,
      [req.params.id, req.user.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });

    const isOwner = rows[0].owner_id === req.user.id;
    const collabRole = rows[0].role;

    if (!isOwner && !collabRole) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const role = isOwner ? 'owner' : collabRole;
    const ticket = createTicket(req.user, req.params.id, role);
    res.json({ ticket });
  } catch {
    res.status(500).json({ error: 'Failed to create ticket' });
  }
}

module.exports = {
  createDocument, listDocuments, getDocument, updateDocument, deleteDocument,
  addCollaborator, getCollaborators, removeCollaborator, searchUsers, createWSTicket,
};
