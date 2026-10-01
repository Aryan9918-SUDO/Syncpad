import { useState } from 'react';

const API = '/api';

export default function AuthForm({ onAuth }) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const endpoint = isLogin ? '/auth/login' : '/auth/register';
    const body = isLogin ? { email, password } : { username, email, password };

    try {
      const res = await fetch(`${API}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onAuth(data.token);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h2>{isLogin ? 'Sign In' : 'Create Account'}</h2>
      {!isLogin && (
        <input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      )}
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && <p className="error-msg">{error}</p>}
      <button type="submit" className="primary">
        {isLogin ? 'Sign In' : 'Sign Up'}
      </button>
      <p className="auth-toggle" onClick={() => setIsLogin(!isLogin)}>
        {isLogin ? (
          <>Don't have an account? <span>Sign Up</span></>
        ) : (
          <>Already have an account? <span>Sign In</span></>
        )}
      </p>
    </form>
  );
}
