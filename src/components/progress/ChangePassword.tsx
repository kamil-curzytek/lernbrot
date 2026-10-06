import { useState, type FormEvent } from 'react';
import { changePassword } from '../../services/authService';
import { NewPasswordFields, newPasswordProblem } from '../auth/NewPasswordFields';

export function ChangePassword({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function reset() {
    setCurrent('');
    setPassword('');
    setConfirm('');
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = newPasswordProblem(password, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await changePassword(email, current, password);
      reset();
      setOpen(false);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="stack">
        {success && <div className="notice">✓ Your password has been changed.</div>}
        <div>
          <button className="btn" onClick={() => { setSuccess(false); setOpen(true); }}>Change password</button>
        </div>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Current password</span>
        <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
      {error && <div className="alert">{error}</div>}
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={() => { reset(); setOpen(false); }}>Cancel</button>
        <button className="btn btn-primary spacer" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
      </div>
    </form>
  );
}
