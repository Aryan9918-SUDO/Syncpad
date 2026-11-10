import { useState, useEffect, useCallback } from 'react';

const API = '/api';

export default function SharePanel({ docId, token, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [collaborators, setCollaborators] = useState([]);
  const [newRole, setNewRole] = useState('editor');
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    fetchCollaborators();
  }, []);

  async function fetchCollaborators() {
    const res = await fetch(`${API}/documents/${docId}/collaborators`, { headers });
    if (res.ok) setCollaborators(await res.json());
  }

  const searchUsers = useCallback(async (q) => {
    setQuery(q);
    if (q.length < 2) { setResults([]); return; }
    const res = await fetch(`${API}/documents/search-users?q=${encodeURIComponent(q)}`, { headers });
    if (res.ok) setResults(await res.json());
  }, []);

  async function addCollab(userId) {
    setError(null);
    setBusyId('add');
    try {
      const res = await fetch(`${API}/documents/${docId}/collaborators`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId, role: newRole }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to add collaborator');
        return;
      }
      setQuery('');
      setResults([]);
      setNewRole('editor');
      await fetchCollaborators();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  }

  async function removeCollab(userId) {
    setError(null);
    setBusyId(userId);
    try {
      const res = await fetch(`${API}/documents/${docId}/collaborators/${userId}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to remove collaborator');
        return;
      }
      await fetchCollaborators();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  }

  async function changeRole(userId, role) {
    setError(null);
    setBusyId(userId);
    try {
      const res = await fetch(`${API}/documents/${docId}/collaborators`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId, role }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to update role');
        return;
      }
      await fetchCollaborators();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="share-panel">
      <div className="share-header">
        <h3>Share Document</h3>
        <button className="secondary" onClick={onClose} style={{ padding: '4px 10px', fontSize: '0.8rem' }}>
          Close
        </button>
      </div>
      {error && <div className="error-msg" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="share-search">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="Search users by name or email..."
            value={query}
            onChange={(e) => searchUsers(e.target.value)}
            autoFocus
            style={{ flex: 1 }}
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            style={{ padding: '6px 8px', fontSize: '0.8rem', width: 'auto' }}
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        {results.length > 0 && (
          <div className="search-results">
            {results.map((u) => (
              <button
                key={u.id}
                className="search-result-item"
                onClick={() => addCollab(u.id)}
                disabled={busyId === 'add'}
                style={{ border: 'none', background: 'none', color: 'inherit', width: '100%', textAlign: 'left', font: 'inherit' }}
              >
                <span>{u.username}</span>
                <span style={{ color: '#a6adc8', fontSize: '0.8rem' }}>{u.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {collaborators.length > 0 && (
        <div className="collab-list">
          <h4>Collaborators</h4>
          {collaborators.map((c) => (
            <div key={c.id} className="collab-item">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="collab-name">{c.username}</span>
                <select
                  value={c.role}
                  onChange={(e) => changeRole(c.id, e.target.value)}
                  disabled={busyId === c.id}
                  style={{ padding: '2px 6px', fontSize: '0.75rem', background: '#313244', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4' }}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button
                className="secondary"
                onClick={() => removeCollab(c.id)}
                disabled={busyId === c.id}
                style={{ padding: '2px 8px', fontSize: '0.75rem', opacity: busyId === c.id ? 0.5 : 1 }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
