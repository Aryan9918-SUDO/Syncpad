import { useState, useEffect, useCallback } from 'react';

const API = '/api';

export default function SharePanel({ docId, token, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [collaborators, setCollaborators] = useState([]);

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
    await fetch(`${API}/documents/${docId}/collaborators`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId, role: 'editor' }),
    });
    setQuery('');
    setResults([]);
    fetchCollaborators();
  }

  async function removeCollab(userId) {
    await fetch(`${API}/documents/${docId}/collaborators/${userId}`, {
      method: 'DELETE',
      headers,
    });
    fetchCollaborators();
  }

  return (
    <div className="share-panel">
      <div className="share-header">
        <h3>Share Document</h3>
        <button className="secondary" onClick={onClose} style={{ padding: '4px 10px', fontSize: '0.8rem' }}>
          Close
        </button>
      </div>
      <div className="share-search">
        <input
          placeholder="Search users by name or email..."
          value={query}
          onChange={(e) => searchUsers(e.target.value)}
          autoFocus
        />
        {results.length > 0 && (
          <div className="search-results">
            {results.map((u) => (
              <div key={u.id} className="search-result-item" onClick={() => addCollab(u.id)}>
                <span>{u.username}</span>
                <span style={{ color: '#a6adc8', fontSize: '0.8rem' }}>{u.email}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {collaborators.length > 0 && (
        <div className="collab-list">
          <h4>Collaborators</h4>
          {collaborators.map((c) => (
            <div key={c.id} className="collab-item">
              <div>
                <span className="collab-name">{c.username}</span>
                <span className="collab-role">{c.role}</span>
              </div>
              <button
                className="secondary"
                onClick={() => removeCollab(c.id)}
                style={{ padding: '2px 8px', fontSize: '0.75rem' }}
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
