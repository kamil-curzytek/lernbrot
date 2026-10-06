import { db } from '../lib/supabase/client';

export const MIN_PASSWORD_LENGTH = 8;

/** Address the email links bring people back to (must be in Supabase's Redirect URLs). */
export function appUrl(): string {
  return window.location.origin + window.location.pathname;
}

function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Your current password is not correct.';
  if (/different from the old password/i.test(message)) return 'The new password must be different from your current one.';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Please wait a few minutes and try again.';
  return message;
}

/** Changes the password of the signed-in user after re-checking their current password. */
export async function changePassword(email: string, currentPassword: string, newPassword: string): Promise<void> {
  const check = await db().auth.signInWithPassword({ email, password: currentPassword });
  if (check.error) throw new Error(friendly(check.error.message));
  const { error } = await db().auth.updateUser({ password: newPassword });
  if (error) throw new Error(friendly(error.message));
}

/** Sends a "reset your password" email. */
export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await db().auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  if (error) throw new Error(friendly(error.message));
}

/** Sets a new password after opening a reset link (the link signs the user in). */
export async function setNewPassword(newPassword: string): Promise<void> {
  const { error } = await db().auth.updateUser({ password: newPassword });
  if (error) throw new Error(friendly(error.message));
}
