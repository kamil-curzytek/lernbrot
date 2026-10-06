import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey && !url.includes('YOUR-PROJECT-REF'));

// Email links (sign-up confirmation, password reset) come back with their result in the
// URL hash. Read it before anything else touches the hash (the app uses hash routing).
const linkParams = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.hash.replace(/^#\/?/, ''));

/** True when the app was opened from a "reset your password" email. */
export const openedFromPasswordResetLink = linkParams.get('type') === 'recovery';

/** Error from an email link, e.g. an expired reset link. */
export const emailLinkError = linkParams.get('error_description')?.replace(/\+/g, ' ') ?? null;

// Only the public anon key ever reaches the browser; RLS protects every row.
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

/** Resolves once Supabase has finished reading any email-link tokens from the URL. */
export function authReady(): Promise<void> {
  return supabase ? supabase.auth.getSession().then(() => undefined, () => undefined) : Promise.resolve();
}

export function db(): SupabaseClient {
  if (!supabase) throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  return supabase;
}

/** Throws the Supabase error (if any) and returns data. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}
