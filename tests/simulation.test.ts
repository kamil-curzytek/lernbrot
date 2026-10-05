// 60 simulated days of one learner: the cloud job prepares each morning's session,
// the learner studies and takes the quiz each evening (~80% correct), and the
// invariants of selection, scheduling and storage are checked every day.
import type { PGlite } from '@electric-sql/pglite';
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSubmission, generateQuiz } from '../src/lib/quiz';
import { createRng } from '../src/lib/quiz/random';
import { statusForStreak, type ProgressSnapshot } from '../src/lib/spacedRepetition';
import { addDays, localDate, zonedMidnight } from '../src/lib/time';
import type { VocabularyWord } from '../src/types';
import { asUser, createTestDb, createUser } from './helpers/db';

const TZ = 'Europe/Berlin';
const DAYS = 60;
type Row = Record<string, any>;

let db: PGlite;
let user: string;
const log: { day: number; date: string; review: number; fresh: number; score: number; dueBefore: number }[] = [];
const problems: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  user = await createUser(db, { timezone: TZ });
  const pool = (await db.query<VocabularyWord>('select * from vocabulary_words')).rows;
  const start = localDate(TZ);
  const rng = createRng('simulation');

  for (let day = 0; day < DAYS; day++) {
    const date = addDays(start, day);
    const midnight = zonedMidnight(date, TZ).getTime();
    const morning = new Date(midnight + 5 * 3600_000);
    const evening = new Date(midnight + 19 * 3600_000);
    const dayEnd = zonedMidnight(addDays(date, 1), TZ).toISOString();

    // what is due before the job runs
    const dueBefore = (await db.query<Row>(
      'select count(*)::int as n from vocabulary_progress where user_id = $1 and next_review_at < $2', [user, dayEnd])).rows[0].n;
    const progressBefore = new Map(
      (await db.query<Row>('select * from vocabulary_progress where user_id = $1', [user])).rows.map((r) => [r.word_id, r]),
    );

    // cloud job, twice (must not duplicate)
    await db.query('select public.run_daily_learning_job($1)', [morning]);
    await db.query('select public.run_daily_learning_job($1)', [morning]);

    const sessions = (await db.query<Row>('select * from daily_sessions where user_id = $1 and session_date = $2', [user, date])).rows;
    if (sessions.length !== 1) { problems.push(`day ${day}: ${sessions.length} sessions`); continue; }
    const s = sessions[0];
    const words = (await db.query<Row>(
      `select sw.kind, row_to_json(w) as word from daily_session_words sw join vocabulary_words w on w.id = sw.word_id
        where sw.session_id = $1 order by sw.position`, [s.id])).rows;

    // --- selection invariants ---
    if (s.total_word_count !== 10 || words.length !== 10) problems.push(`day ${day}: ${words.length} words`);
    for (const w of words) {
      const had = progressBefore.has(w.word.id);
      if (w.kind === 'new' && had) problems.push(`day ${day}: "${w.word.german}" offered as new but already seen`);
      if (w.kind === 'review' && !had) problems.push(`day ${day}: "${w.word.german}" offered as review but never seen`);
    }
    const minNew = dueBefore <= 10 ? 2 : dueBefore < 20 ? 1 : 0; // normal / busy / catch-up day
    if (s.new_word_count < minNew) problems.push(`day ${day}: only ${s.new_word_count} new words with ${dueBefore} due`);
    if (dueBefore <= 8) {
      const dueIds = [...progressBefore.values()].filter((p) => p.next_review_at.toISOString() < dayEnd).map((p) => p.word_id);
      const inSession = new Set(words.map((w) => w.word.id));
      for (const id of dueIds) if (!inSession.has(id)) problems.push(`day ${day}: due word ${id} left out with room to spare`);
    }

    // --- evening: study + quiz ---
    const items = words.map((w) => ({ word: w.word as VocabularyWord, progress: (progressBefore.get(w.word.id) ?? null) as Row | null }));
    const quiz = generateQuiz(items.map((i) => ({ word: i.word, progress: i.progress as any })), pool, s.id);
    if (new Set(quiz.map((q) => q.wordId)).size !== 10) problems.push(`day ${day}: quiz doesn't cover the session`);
    const answers: Record<string, string> = {};
    for (const q of quiz) answers[q.id] = rng() < 0.8 ? q.correctAnswer : 'wrong';
    const snap = new Map<number, ProgressSnapshot>(items.filter((i) => i.progress).map((i) => [i.word.id, i.progress as any]));
    const sub = buildSubmission(quiz, answers, snap, { now: evening, timeZone: TZ });

    await asUser(db, user, () =>
      db.query('select submit_quiz($1, 300, $2::jsonb, $3::jsonb)', [s.id, JSON.stringify(sub.answers), JSON.stringify(sub.schedule)]));

    log.push({ day, date, review: s.review_word_count, fresh: s.new_word_count, score: sub.score, dueBefore });
  }
}, 600_000);

describe(`${DAYS}-day simulation`, () => {
  it('every day the job prepared exactly one session of 10 words, with the right words', () => {
    expect(problems).toEqual([]);
    expect(log).toHaveLength(DAYS);
  });

  it('the mix adapts: 10 new on day one, then reviews first, with new words whenever there is room', () => {
    expect(log[0]).toMatchObject({ review: 0, fresh: 10 });
    expect(log[1]).toMatchObject({ review: 8, fresh: 2 });
    expect(log.every((d) => d.review + d.fresh === 10)).toBe(true);
    // learning keeps moving: a steady stream of new words over the 60 days
    expect(log.reduce((n, d) => n + d.fresh, 0)).toBeGreaterThanOrEqual(60);
  });

  it('all sessions and quizzes were stored', async () => {
    const r = (await db.query<Row>(
      `select (select count(*)::int from daily_sessions where user_id = $1 and status = 'completed') as sessions,
              (select count(*)::int from quiz_attempts where user_id = $1) as attempts,
              (select count(*)::int from quiz_answers a join quiz_attempts t on t.id = a.quiz_attempt_id where t.user_id = $1) as answers`,
      [user])).rows[0];
    expect(r).toEqual({ sessions: DAYS, attempts: DAYS, answers: DAYS * 10 });
  });

  it('every word\'s status matches its streak, and its counters add up', async () => {
    const rows = (await db.query<Row>('select * from vocabulary_progress where user_id = $1', [user])).rows;
    for (const p of rows) {
      expect(p.times_seen, `word ${p.word_id}`).toBe(p.times_correct + p.times_incorrect);
      // after a miss the word is 'learning' even though its halved streak may be higher
      expect(['learning', statusForStreak(p.streak)], `word ${p.word_id}: ${p.status}/${p.streak}`).toContain(p.status);
    }
    const newWords = log.reduce((n, d) => n + d.fresh, 0);
    expect(rows.length).toBe(newWords); // each new word introduced exactly once
  });

  it('well-known words drift out to long intervals; the review load stays bounded', async () => {
    const rows = (await db.query<Row>('select streak, status from vocabulary_progress where user_id = $1', [user])).rows;
    expect(rows.some((r) => r.status === 'strong')).toBe(true);
    expect(rows.some((r) => r.streak >= 5)).toBe(true);
    // the backlog of due words stays bounded (catch-up days start at 2x the daily target)
    expect(Math.max(...log.map((d) => d.dueBefore))).toBeLessThanOrEqual(30);
    expect(log.slice(-10).every((d) => d.dueBefore <= 25)).toBe(true);
  });

  it('prints a summary', () => {
    const avg = (log.reduce((n, d) => n + d.score, 0) / log.length).toFixed(1);
    const sample = log.filter((d) => d.day % 3 === 0 || d.day < 6).map((d) => `day ${d.day} ${d.date}: ${d.review} review + ${d.fresh} new, due ${d.dueBefore}, score ${d.score}/10`);
    if (process.env.SIM_OUT) writeFileSync(process.env.SIM_OUT, `${sample.join('\n')}\naverage score ${avg}/10, new words met: ${log.reduce((n, d) => n + d.fresh, 0)}\n`);
  });
});
