const pool = require('../config/db');

async function createDocument(req, res) {
  const { title, language } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO documents (title, language, owner_id) VALUES ($1, $2, $3) RETURNING *',
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
      `SELECT d.* FROM documents d
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
  try {
    const { rows } = await pool.query(
      `SELECT d.* FROM documents d
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
  const { title, language } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE documents SET title = COALESCE($1, title), language = COALESCE($2, language), updated_at = NOW()
       WHERE id = $3 AND owner_id = $4 RETURNING *`,
      [title, language, req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to update document' });
  }
}

async function deleteDocument(req, res) {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM documents WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Failed to delete document' });
  }
}

async function addCollaborator(req, res) {
  const { userId, role } = req.body;
  try {
    const docCheck = await pool.query('SELECT owner_id FROM documents WHERE id = $1', [req.params.id]);
    if (docCheck.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    if (docCheck.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the owner can add collaborators' });
    }

    await pool.query(
      'INSERT INTO document_collaborators (document_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (document_id, user_id) DO UPDATE SET role = $3',
      [req.params.id, userId, role || 'editor']
    );
    res.status(201).json({ message: 'Collaborator added' });
  } catch {
    res.status(500).json({ error: 'Failed to add collaborator' });
  }
}

async function getCollaborators(req, res) {
  try {
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

module.exports = {
  createDocument, listDocuments, getDocument, updateDocument, deleteDocument,
  addCollaborator, getCollaborators, removeCollaborator, searchUsers,
};
