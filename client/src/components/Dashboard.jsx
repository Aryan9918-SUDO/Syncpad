import { useState, useEffect } from 'react';

const API = '/api';

export default function Dashboard({ token, user, onOpenDoc, onLogout }) {
  const [docs, setDocs] = useState([]);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('javascript');

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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: title || 'Untitled', language }),
    });
    if (res.ok) {
      const doc = await res.json();
      setTitle('');
      setDocs((prev) => [doc, ...prev]);
      onOpenDoc(doc.id);
    }
  }

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

      {docs.length > 0 && (
        <div className="doc-list">
          <h3>Your Documents</h3>
          {docs.map((doc) => (
            <div key={doc.id} className="doc-item" onClick={() => onOpenDoc(doc.id)}>
              <span className="doc-title">{doc.title}</span>
              <span className="doc-lang">{doc.language}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
