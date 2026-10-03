import { db, unwrap } from '../lib/supabase/client';
import type { CefrLevel, Profile } from '../types';

export async function getProfile(userId: string): Promise<Profile> {
  return unwrap(await db().from('profiles').select('*').eq('id', userId).single());
}

export async function completeOnboarding(userId: string, level: CefrLevel, dailyTarget: number, timezone: string): Promise<Profile> {
  return unwrap(
    await db()
      .from('profiles')
      .update({ current_cefr_level: level, daily_word_target: dailyTarget, timezone, onboarded_at: new Date().toISOString() })
      .eq('id', userId)
      .select('*')
      .single(),
  );
}

export async function updateSettings(
  userId: string,
  patch: Partial<Pick<Profile, 'current_cefr_level' | 'daily_word_target' | 'timezone'>>,
): Promise<Profile> {
  return unwrap(await db().from('profiles').update(patch).eq('id', userId).select('*').single());
}
