import { currentStreak, summarizeProgress, type ProgressSummary } from '../lib/dailySession/stats';
import { db, unwrap } from '../lib/supabase/client';
import { localDate } from '../lib/time';
import type { VocabularyProgress } from '../types';

export async function listProgress(): Promise<VocabularyProgress[]> {
  return unwrap(await db().from('vocabulary_progress').select('*')) as VocabularyProgress[];
}

export async function progressByWord(wordIds: readonly number[]): Promise<Map<number, VocabularyProgress>> {
  if (wordIds.length === 0) return new Map();
  const rows = unwrap(await db().from('vocabulary_progress').select('*').in('word_id', wordIds as number[])) as VocabularyProgress[];
  return new Map(rows.map((r) => [r.word_id, r]));
}

export interface DashboardStats extends ProgressSummary {
  streak: number;
}

export async function getDashboardStats(timeZone: string): Promise<DashboardStats> {
  const [progress, sessions] = await Promise.all([
    listProgress(),
    db().from('daily_sessions').select('session_date').eq('status', 'completed').order('session_date', { ascending: false }).limit(400),
  ]);
  const dates = (unwrap(sessions) as { session_date: string }[]).map((s) => s.session_date);
  return { ...summarizeProgress(progress), streak: currentStreak(dates, localDate(timeZone)) };
}
