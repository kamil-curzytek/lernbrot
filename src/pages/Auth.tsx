import { useState, type FormEvent } from 'react';
import { emailLinkError, supabase } from '../lib/supabase/client';
import { appUrl, MIN_PASSWORD_LENGTH, sendPasswordReset } from '../services/authService';

type Mode = 'signin' | 'signup' | 'forgot';

const TITLES: Record<Mode, string> = {
  signin: 'Sign in',
  signup: 'Create your account',
  forgot: 'Reset your password',
};

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    emailLinkError ? `That email link didn't work (${emailLinkError}). Please try again.` : null,
  );
  const [info, setInfo] = useState<string | null>(null);

  function switchTo(m: Mode) {
    setMode(m);
    setError(null);
    setInfo(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === 'forgot') {
        await sendPasswordReset(email);
        setInfo(`If an account exists for ${email}, we've sent a link to set a new password. Check your inbox (and spam).`);
      } else if (mode === 'signup') {
        const { data, error } = await supabase!.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
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
            Lern<span style={{ color: 'var(--accent)' }}>brot</span>
          </h1>
          <p className="muted">Your daily bread of German.</p>
        </div>
        <form className="card stack" onSubmit={submit}>
          <h2>{TITLES[mode]}</h2>
          {mode === 'forgot' && <p className="muted small" style={{ margin: 0 }}>Enter your email and we'll send you a link to choose a new password.</p>}
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {mode !== 'forgot' && (
            <label className="field">
              <span>{mode === 'signup' ? `Password (at least ${MIN_PASSWORD_LENGTH} characters)` : 'Password'}</span>
              <input
                className="input"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                minLength={mode === 'signup' ? MIN_PASSWORD_LENGTH : undefined}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          {error && <div className="alert">{error}</div>}
          {info && <div className="notice">{info}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Sign up' : 'Send reset link'}
          </button>
          {mode === 'signin' && (
            <button type="button" className="btn btn-ghost btn-block" onClick={() => switchTo('forgot')}>
              Forgot password?
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-block" onClick={() => switchTo(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? 'New here? Create an account' : 'Back to sign in'}
          </button>
        </form>
        <p className="muted small center">Your progress is saved to your account, so it follows you to any device.</p>
      </div>
    </div>
  );
}
