import { useState, useEffect } from 'react';
import Editor from './components/Editor';
import AuthForm from './components/AuthForm';
import Dashboard from './components/Dashboard';

const API = '/api';

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('syncpad_token'));
  const [user, setUser] = useState(null);
  const [docId, setDocId] = useState(null);

  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setUser)
      .catch(() => {
        localStorage.removeItem('syncpad_token');
        setToken(null);
      });
  }, [token]);

  function handleAuth(tok) {
    localStorage.setItem('syncpad_token', tok);
    setToken(tok);
  }

  function handleLogout() {
    localStorage.removeItem('syncpad_token');
    setToken(null);
    setUser(null);
    setDocId(null);
  }

  if (!token || !user) {
    return (
      <div className="landing">
        <h1>SyncPad</h1>
        <p>Real-time collaborative code editor powered by CRDTs. Edit code together with zero conflicts.</p>
        <AuthForm onAuth={handleAuth} />
      </div>
    );
  }

  if (docId) {
    return (
      <Editor
        docId={docId}
        token={token}
        user={user}
        onBack={() => setDocId(null)}
      />
    );
  }

  return (
    <Dashboard
      token={token}
      user={user}
      onOpenDoc={setDocId}
      onLogout={handleLogout}
    />
  );
}
