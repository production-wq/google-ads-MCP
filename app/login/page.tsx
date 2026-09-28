'use client';
import { useState } from 'react';

type Session = { username: string; role: string; can_write: boolean; token: string; expires_at: string; endpoint: string | null };

const box: React.CSSProperties = { width: '100%', padding: '10px 12px', marginTop: 6, borderRadius: 8,
  border: '1px solid #2c313a', background: '#171a20', color: '#e8eaed', fontSize: 15, boxSizing: 'border-box' };
const label: React.CSSProperties = { display: 'block', marginTop: 16, fontSize: 13, color: '#9aa3af' };

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<Session | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }) });
      const data = await response.json();
      if (!response.ok) setError(data.error || 'Sign-in failed.');
      else { setSession(data); setPassword(''); }
    } catch { setError('Could not reach the server.'); }
    finally { setBusy(false); }
  }

  const endpoint = session?.endpoint || 'https://YOUR-PROJECT.vercel.app/api/mcp';
  const config = JSON.stringify({ mcpServers: { 'google-ads-worksheet': { url: endpoint,
    headers: { Authorization: `Bearer ${session?.token ?? ''}` } } } }, null, 2);

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '48px 16px' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Google Ads Worksheet MCP</h1>
      <p style={{ color: '#9aa3af', marginTop: 0, fontSize: 14 }}>
        Internal access. Sign in to get the token your AI client needs.
      </p>

      {!session && (
        <form onSubmit={submit}>
          <label style={label}>Username
            <input style={box} value={username} onChange={e => setUsername(e.target.value)}
              autoComplete="username" autoCapitalize="none" required />
          </label>
          <label style={label}>Password
            <input style={box} type="password" value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="current-password" required />
          </label>
          <button type="submit" disabled={busy || !username || !password}
            style={{ ...box, marginTop: 24, cursor: busy ? 'progress' : 'pointer', background: '#2f6feb',
              borderColor: '#2f6feb', fontWeight: 600 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error && <p style={{ color: '#ff7b72', fontSize: 14 }} role="alert">{error}</p>}
        </form>
      )}

      {session && (
        <section>
          <p style={{ fontSize: 14 }}>
            Signed in as <strong>{session.username}</strong> — {session.can_write
              ? 'this token can change Google Ads and the sheet.'
              : 'read-only token.'}<br />
            <span style={{ color: '#9aa3af' }}>Valid until {new Date(session.expires_at).toLocaleString()}.</span>
          </p>
          <label style={label}>Your token — treat it like a password
            <textarea style={{ ...box, height: 90, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              readOnly value={session.token} onFocus={e => e.currentTarget.select()} />
          </label>
          <button type="button" onClick={() => navigator.clipboard?.writeText(session.token)}
            style={{ ...box, marginTop: 10, cursor: 'pointer' }}>Copy token</button>
          <label style={label}>Client configuration
            <textarea style={{ ...box, height: 170, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              readOnly value={config} onFocus={e => e.currentTarget.select()} />
          </label>
          <p style={{ color: '#9aa3af', fontSize: 13 }}>
            For Claude or ChatGPT remote connectors, add the URL above and send the token as a Bearer
            <code> Authorization</code> header. Every change still needs a confirmation step.
          </p>
          <button type="button" onClick={() => setSession(null)} style={{ ...box, marginTop: 10, cursor: 'pointer' }}>
            Sign out of this page
          </button>
        </section>
      )}
    </main>
  );
}
