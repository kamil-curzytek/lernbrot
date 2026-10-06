import { MIN_PASSWORD_LENGTH } from '../../services/authService';

/** New password + confirmation. Returns a problem message, or null when valid. */
export function newPasswordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}

interface Props {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
}

export function NewPasswordFields({ password, confirm, onPassword, onConfirm }: Props) {
  return (
    <>
      <label className="field">
        <span>New password (at least {MIN_PASSWORD_LENGTH} characters)</span>
        <input className="input" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH}
          value={password} onChange={(e) => onPassword(e.target.value)} />
      </label>
      <label className="field">
        <span>Repeat new password</span>
        <input className="input" type="password" autoComplete="new-password" required
          value={confirm} onChange={(e) => onConfirm(e.target.value)} />
      </label>
    </>
  );
}
