import { buildSubmission, generateQuiz, type QuizQuestion, type QuizSubmission } from '../lib/quiz';
import type { ProgressSnapshot } from '../lib/spacedRepetition';
import { db, unwrap } from '../lib/supabase/client';
import type { QuizAnswerRow, QuizAttempt, SessionItem } from '../types';
import { listWords } from './vocabularyService';

/** Deterministic quiz for a session: same questions on every reload and device. */
export async function buildQuizForSession(sessionId: string, items: readonly SessionItem[]): Promise<QuizQuestion[]> {
  const pool = await listWords();
  return generateQuiz(items.map((i) => ({ word: i.word, progress: i.progress })), pool, sessionId);
}

export interface SubmitResult {
  attempt: QuizAttempt;
  submission: QuizSubmission;
}

/** Grades locally (deterministic), then stores attempt, answers and new schedule in one transaction. */
export async function submitQuiz(params: {
  sessionId: string;
  questions: readonly QuizQuestion[];
  answers: Readonly<Record<string, string>>;
  items: readonly SessionItem[];
  timeZone: string;
  durationSeconds: number;
}): Promise<SubmitResult> {
  const progress = new Map<number, ProgressSnapshot>();
  for (const i of params.items) if (i.progress) progress.set(i.word.id, i.progress);
  const submission = buildSubmission(params.questions, params.answers, progress, { now: new Date(), timeZone: params.timeZone });
  const attempt = unwrap(
    await db().rpc('submit_quiz', {
      p_session_id: params.sessionId,
      p_duration_seconds: Math.round(params.durationSeconds),
      p_answers: submission.answers,
      p_schedule: submission.schedule,
    }),
  ) as QuizAttempt;
  return { attempt, submission };
}

export async function getAttemptForSession(sessionId: string): Promise<{ attempt: QuizAttempt; answers: QuizAnswerRow[] } | null> {
  const attempt = unwrap(await db().from('quiz_attempts').select('*').eq('daily_session_id', sessionId).maybeSingle()) as QuizAttempt | null;
  if (!attempt) return null;
  const answers = unwrap(await db().from('quiz_answers').select('*').eq('quiz_attempt_id', attempt.id)) as QuizAnswerRow[];
  return { attempt, answers };
}

export async function listAttempts(limit = 30): Promise<QuizAttempt[]> {
  return unwrap(await db().from('quiz_attempts').select('*').order('quiz_date', { ascending: false }).limit(limit)) as QuizAttempt[];
}
