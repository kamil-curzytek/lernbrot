import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase/client';

export default function AuthPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase!.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + window.location.pathname },
        });
        if (error) throw error;
        if (!data.session) setInfo('Check your inbox to confirm your email, then sign in.');
      } else {
        const { error } = await supabase!.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="main narrow">
      <div className="stack" style={{ marginTop: '8vh' }}>
        <div className="center">
          <h1>
            German<span style={{ color: 'var(--accent)' }}>izer</span>
          </h1>
          <p className="muted">Learn German, one useful step at a time.</p>
        </div>
        <form className="card stack" onSubmit={submit}>
          <h2>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h2>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <div className="alert">{error}</div>}
          {info && <div className="notice">{info}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>
        <p className="muted small center">Your progress is saved to your account, so it follows you to any device.</p>
      </div>
    </div>
  );
}
