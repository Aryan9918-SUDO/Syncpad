import { useState, useEffect } from 'react';

const API = '/api';

export default function Dashboard({ token, user, onOpenDoc, onLogout }) {
  const [docs, setDocs] = useState([]);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    fetchDocs();
  }, []);

  async function fetchDocs() {
    const res = await fetch(`${API}/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setDocs(await res.json());
  }

  async function createDoc(e) {
    e.preventDefault();
    const res = await fetch(`${API}/documents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: title || 'Untitled', language }),
    });
    if (res.ok) {
      const doc = await res.json();
      setTitle('');
      setDocs((prev) => [doc, ...prev]);
      onOpenDoc(doc.id);
    }
  }

  function startRename(doc) {
    setEditingId(doc.id);
    setEditTitle(doc.title);
    setError(null);
  }

  async function saveRename(docId) {
    const trimmed = editTitle.trim();
    if (!trimmed) return;
    setError(null);
    setBusyId(docId);
    try {
      const res = await fetch(`${API}/documents/${docId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to rename');
        return;
      }
      const updated = await res.json();
      setDocs((prev) => prev.map((d) => (d.id === docId ? { ...d, title: updated.title } : d)));
      setEditingId(null);
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteDoc(doc) {
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    setError(null);
    setBusyId(doc.id);
    try {
      const res = await fetch(`${API}/documents/${doc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to delete');
        return;
      }
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  }

  const roleLabel = (role) => {
    const colors = { owner: '#cba6f7', editor: '#a6e3a1', viewer: '#89b4fa' };
    return (
      <span style={{
        fontSize: '0.75rem',
        color: colors[role] || '#a6adc8',
        padding: '1px 6px',
        background: '#313244',
        borderRadius: 4,
      }}>
        {role}
      </span>
    );
  };

  return (
    <div className="landing">
      <div className="app-header" style={{ width: '100%' }}>
        <h1>SyncPad</h1>
        <div className="doc-info">
          <span style={{ color: '#a6adc8' }}>Hi, {user.username}</span>
          <button className="secondary" onClick={onLogout} style={{ padding: '6px 14px', fontSize: '0.8rem' }}>
            Logout
          </button>
        </div>
      </div>

      <form onSubmit={createDoc} style={{ display: 'flex', gap: 8, marginTop: 32 }}>
        <input
          placeholder="Document title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ width: 240 }}
        />
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="html">HTML</option>
          <option value="css">CSS</option>
          <option value="json">JSON</option>
        </select>
        <button type="submit" className="primary">New Document</button>
      </form>

      {error && <div className="error-msg" style={{ marginTop: 8 }}>{error}</div>}

      {docs.length > 0 && (
        <div className="doc-list">
          <h3>Your Documents</h3>
          {docs.map((doc) => (
            <div key={doc.id} className="doc-item" style={{ cursor: editingId === doc.id ? 'default' : 'pointer' }}>
              {editingId === doc.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }} onClick={(e) => e.stopPropagation()}>
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename(doc.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    autoFocus
                    style={{ flex: 1, padding: '4px 8px', fontSize: '0.9rem' }}
                  />
                  <button
                    className="primary"
                    onClick={() => saveRename(doc.id)}
                    disabled={busyId === doc.id}
                    style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                  >
                    Save
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setEditingId(null)}
                    style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }} onClick={() => onOpenDoc(doc.id)}>
                    <span className="doc-title">{doc.title}</span>
                    {roleLabel(doc.role)}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                    <span className="doc-lang">{doc.language}</span>
                    {doc.role === 'owner' && (
                      <>
                        <button
                          className="secondary"
                          onClick={() => startRename(doc)}
                          disabled={busyId === doc.id}
                          style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                        >
                          Rename
                        </button>
                        <button
                          className="secondary"
                          onClick={() => deleteDoc(doc)}
                          disabled={busyId === doc.id}
                          style={{ padding: '2px 8px', fontSize: '0.75rem', color: '#f38ba8' }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
