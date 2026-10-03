// Runs the real migrations + seed on PGlite (Postgres compiled to WASM) with a
// minimal stand-in for the parts of Supabase the schema depends on: the auth
// schema, auth.uid(), the anon/authenticated roles and Supabase's default grants.
// pg_cron is not available here, so the cron migration (0003) is skipped.

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

const SUPABASE_STUB = `
create schema auth;
create table auth.users (id uuid primary key, email text);
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
-- Supabase grants everything to the API roles by default; RLS + explicit revokes must hold anyway.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
`;

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const dir = join(root, 'supabase', 'migrations');
  for (const file of readdirSync(dir).sort()) {
    if (file.includes('cron')) continue;
    await db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  await db.exec(readFileSync(join(root, 'supabase', 'seed', 'content.sql'), 'utf8'));
  return db;
}

let counter = 0;
export async function createUser(db: PGlite, opts: { level?: string; target?: number; timezone?: string; onboard?: boolean } = {}) {
  counter++;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `user${counter}@test.local`]);
  if (opts.onboard !== false) {
    await db.query(
      `update public.profiles set current_cefr_level = $2, daily_word_target = $3, timezone = $4, onboarded_at = now() where id = $1`,
      [id, opts.level ?? 'A1', opts.target ?? 10, opts.timezone ?? 'Europe/Berlin'],
    );
  }
  return id;
}

/** Runs `fn` as a signed-in user (role authenticated, auth.uid() = userId), like a PostgREST request. */
export async function asUser<T>(db: PGlite, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  await db.exec(userId ? 'set role authenticated' : 'set role anon');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
