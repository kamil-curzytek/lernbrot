import { db, unwrap } from '../lib/supabase/client';
import type { DailySession, SessionItem } from '../types';
import { topicsForWords } from './grammarService';
import { progressByWord } from './progressService';
import { getWordsByIds } from './vocabularyService';

/**
 * Returns today's session for the signed-in user, creating it if needed.
 * Safe to call repeatedly: the database enforces one session per (user, local date),
 * and the scheduled job uses the same SQL function (create_daily_session_for).
 */
export async function createDailySession(userId: string): Promise<DailySession> {
  const session = unwrap(await db().rpc('create_my_daily_session')) as DailySession;
  if (session.user_id !== userId) throw new Error('Session belongs to a different user.');
  return session;
}

export async function getSession(sessionId: string): Promise<DailySession> {
  return unwrap(await db().from('daily_sessions').select('*').eq('id', sessionId).single()) as DailySession;
}

/** The session's words with content, the learner's progress and linked grammar. */
export async function getSessionItems(sessionId: string): Promise<SessionItem[]> {
  const rows = unwrap(
    await db().from('daily_session_words').select('word_id, position, kind').eq('session_id', sessionId).order('position'),
  ) as { word_id: number; position: number; kind: 'new' | 'review' }[];
  const ids = rows.map((r) => r.word_id);
  const [words, progress, grammar] = await Promise.all([getWordsByIds(ids), progressByWord(ids), topicsForWords(ids)]);
  return rows.map((r) => ({
    word: words.get(r.word_id)!,
    kind: r.kind,
    position: r.position,
    progress: progress.get(r.word_id) ?? null,
    grammarTopics: grammar.get(r.word_id) ?? [],
  }));
}

/** Remembers how far the learner got through the study cards (only moves forward). */
export async function saveStudyPosition(sessionId: string, position: number): Promise<void> {
  unwrap(await db().rpc('save_session_progress', { p_session_id: sessionId, p_study_position: position }));
}

/** Saves one quiz answer as soon as it is given. An answer already saved is never replaced. */
export async function saveQuizAnswer(sessionId: string, questionId: string, answer: string): Promise<void> {
  unwrap(await db().rpc('save_session_progress', { p_session_id: sessionId, p_question_id: questionId, p_answer: answer }));
}
