import { useState, type FormEvent } from 'react';
import { NewPasswordFields, newPasswordProblem } from '../components/auth/NewPasswordFields';
import { setNewPassword } from '../services/authService';

/** Shown after opening a "reset your password" email link. */
export default function ResetPassword({ email, onDone }: { email: string | undefined; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = newPasswordProblem(password, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await setNewPassword(password);
      setDone(true);
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
        </div>
        {done ? (
          <div className="card stack">
            <h2>Password changed</h2>
            <p className="muted" style={{ margin: 0 }}>Your new password is saved. Use it next time you sign in.</p>
            <button className="btn btn-primary btn-block" onClick={onDone}>Continue to Lernbrot</button>
          </div>
        ) : (
          <form className="card stack" onSubmit={submit}>
            <h2>Set a new password</h2>
            {email && <p className="muted small" style={{ margin: 0 }}>For {email}</p>}
            <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
            {error && <div className="alert">{error}</div>}
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
