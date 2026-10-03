// Integration tests: real migrations + seed on Postgres (PGlite), exercising the
// SQL functions the app and the cloud job call, together with the TypeScript
// quiz engine and spaced repetition, through the MVP definition-of-done loop.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSubmission, generateQuiz, type QuizQuestion } from '../src/lib/quiz';
import type { ProgressSnapshot } from '../src/lib/spacedRepetition';
import { addDays, localDate, zonedMidnight } from '../src/lib/time';
import type { VocabularyWord } from '../src/types';
import { asUser, createTestDb, createUser } from './helpers/db';

const TZ = 'Europe/Berlin';
let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

type Row = Record<string, any>;
const rows = async (sql: string, params: unknown[] = []) => (await db.query<Row>(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];

/** Everything the app loads for a session, read as the signed-in user (RLS applies). */
async function loadSession(userId: string, sessionId: string) {
  return asUser(db, userId, async () => {
    const items = await rows(
      `select sw.kind, sw.position, row_to_json(w) as word, row_to_json(p) as progress
         from daily_session_words sw
         join vocabulary_words w on w.id = sw.word_id
         left join vocabulary_progress p on p.word_id = sw.word_id and p.user_id = auth.uid()
        where sw.session_id = $1
        order by sw.position`,
      [sessionId],
    );
    const pool = (await rows('select * from vocabulary_words')) as VocabularyWord[];
    return { items, pool };
  });
}

async function takeQuiz(userId: string, sessionId: string, now: Date, wrongCount: number) {
  const { items, pool } = await loadSession(userId, sessionId);
  const quiz = generateQuiz(items.map((i) => ({ word: i.word, progress: i.progress })), pool, sessionId);
  const answers: Record<string, string> = {};
  quiz.forEach((q: QuizQuestion, i: number) => (answers[q.id] = i < quiz.length - wrongCount ? q.correctAnswer : 'nope'));
  const progress = new Map<number, ProgressSnapshot>(
    items.filter((i) => i.progress).map((i) => [i.word.id, i.progress as ProgressSnapshot]),
  );
  const sub = buildSubmission(quiz, answers, progress, { now, timeZone: TZ });
  const attempt = await asUser(db, userId, () =>
    one('select * from submit_quiz($1, $2, $3::jsonb, $4::jsonb)', [sessionId, 95, JSON.stringify(sub.answers), JSON.stringify(sub.schedule)]),
  );
  return { quiz, sub, attempt, items };
}

// ---------------------------------------------------------------------------

describe('MVP definition of done: the daily loop', () => {
  let userId: string;
  let day1: Row;
  let day1Missed: number[];
  const today = localDate(TZ);
  const tomorrow = addDays(today, 1);

  it('user signs up -> profile with defaults is created', async () => {
    userId = await createUser(db, { onboard: false });
    const p = await asUser(db, userId, () => one('select * from profiles'));
    expect(p.id).toBe(userId);
    expect(p.daily_word_target).toBe(10);
    expect(p.onboarded_at).toBeNull();
  });

  it('chooses A1 during onboarding (direct profile update under RLS)', async () => {
    const updated = await asUser(db, userId, () =>
      rows(`update profiles set current_cefr_level = 'A1', daily_word_target = 10, timezone = $1, onboarded_at = now()
             where id = auth.uid() returning *`, [TZ]),
    );
    expect(updated).toHaveLength(1);
  });

  it('receives exactly 10 useful new A1 words on day one, across several topics', async () => {
    day1 = await asUser(db, userId, () => one('select * from create_my_daily_session()'));
    expect(day1.total_word_count).toBe(10);
    expect(day1.new_word_count).toBe(10);
    expect(day1.review_word_count).toBe(0);
    const { items } = await loadSession(userId, day1.id);
    expect(items).toHaveLength(10);
    expect(items.every((i) => i.kind === 'new' && i.word.cefr_level === 'A1')).toBe(true);
    expect(new Set(items.map((i) => i.word.topic)).size).toBeGreaterThanOrEqual(6);
  });

  it('calling createDailySession again returns the same session (idempotent)', async () => {
    const again = await asUser(db, userId, () => one('select * from create_my_daily_session()'));
    expect(again.id).toBe(day1.id);
    const created = await db.query<Row>('select public.run_daily_learning_job() as n');
    expect(created.rows[0].n).toBe(0);
    expect((await one('select count(*)::int as n from daily_sessions where user_id = $1', [userId])).n).toBe(1);
    expect((await one('select count(*)::int as n from daily_session_words where session_id = $1', [day1.id])).n).toBe(10);
  });

  it('studies, takes the quiz, gets 8/10: every answer is saved', async () => {
    const { quiz, sub, attempt, items } = await takeQuiz(userId, day1.id, new Date(), 2);
    // quiz is only about today's words
    expect(new Set(quiz.map((q) => q.wordId))).toEqual(new Set(items.map((i) => i.word.id)));
    expect(attempt.score).toBe(8);
    expect(attempt.total_questions).toBe(10);
    day1Missed = sub.incorrectWordIds;
    expect(day1Missed).toHaveLength(2);

    const answers = await asUser(db, userId, () => rows('select * from quiz_answers where quiz_attempt_id = $1', [attempt.id]));
    expect(answers).toHaveLength(10);
    expect(answers.filter((a) => !a.is_correct).map((a) => a.word_id).sort()).toEqual([...day1Missed].sort());

    const session = await asUser(db, userId, () => one('select * from daily_sessions where id = $1', [day1.id]));
    expect(session.status).toBe('completed');
    expect(session.quiz_score).toBe(8);
  });

  it('cannot be scored twice', async () => {
    await expect(takeQuiz(userId, day1.id, new Date(), 0)).rejects.toThrow(/already completed/);
  });

  it('progress and review dates are stored for every word', async () => {
    const progress = await asUser(db, userId, () => rows('select * from vocabulary_progress'));
    expect(progress).toHaveLength(10);
    const due = zonedMidnight(tomorrow, TZ).getTime();
    for (const p of progress) {
      expect(p.times_seen).toBe(1);
      expect(new Date(p.next_review_at).getTime()).toBe(due);
      if (day1Missed.includes(p.word_id)) {
        expect([p.status, p.streak, p.times_incorrect, p.times_correct]).toEqual(['learning', 0, 1, 0]);
      } else {
        expect([p.status, p.streak, p.times_incorrect, p.times_correct]).toEqual(['learning', 1, 0, 1]);
      }
    }
  });

  it('next morning the cloud job prepares the session: the missed words + reviews + new words', async () => {
    // the job before 03:00 local time does nothing
    const early = new Date(zonedMidnight(tomorrow, TZ).getTime() + 2 * 3600_000);
    expect((await one('select public.run_daily_learning_job($1) as n', [early])).n).toBe(0);

    const morning = new Date(zonedMidnight(tomorrow, TZ).getTime() + 5 * 3600_000);
    expect((await one('select public.run_daily_learning_job($1) as n', [morning])).n).toBeGreaterThanOrEqual(1);
    expect((await one('select public.run_daily_learning_job($1) as n', [morning])).n).toBe(0); // no duplicates

    const day2 = await asUser(db, userId, () => one('select * from daily_sessions where session_date = $1', [tomorrow]));
    expect(day2.total_word_count).toBe(10);
    expect(day2.review_word_count).toBe(8);
    expect(day2.new_word_count).toBe(2);

    const { items } = await loadSession(userId, day2.id);
    const reviewIds = items.filter((i) => i.kind === 'review').map((i) => i.word.id);
    for (const id of day1Missed) expect(reviewIds).toContain(id);
    // the missed words are prioritised first
    expect(reviewIds.slice(0, 2).sort()).toEqual([...day1Missed].sort());
    // the new words are words never seen before
    const day1Ids = (await loadSession(userId, day1.id)).items.map((i) => i.word.id);
    for (const i of items.filter((x) => x.kind === 'new')) expect(day1Ids).not.toContain(i.word.id);
    expect(items.filter((i) => i.kind === 'review').every((i) => i.progress.status === 'review')).toBe(true);

    // day 2 quiz: correct-once words get harder retrieval than missed words
    const day2Now = new Date(morning.getTime() + 3 * 3600_000);
    const { quiz } = await takeQuiz(userId, day2.id, day2Now, 0);
    const levelOf = new Map(quiz.map((q) => [q.wordId, q.level]));
    for (const id of day1Missed) expect(levelOf.get(id)).toBeLessThanOrEqual(2);
    const known = reviewIds.filter((id) => !day1Missed.includes(id));
    expect(Math.max(...known.map((id) => levelOf.get(id)!))).toBeGreaterThanOrEqual(2);

    // correct twice in a row -> familiar, 2-day interval
    const p = await asUser(db, userId, () => one('select * from vocabulary_progress where word_id = $1', [known[0]]));
    expect(p.status).toBe('familiar');
    expect(p.streak).toBe(2);
    expect(new Date(p.next_review_at).getTime()).toBe(zonedMidnight(addDays(tomorrow, 2), TZ).getTime());
  });

  it('the job leaves an audit trail', async () => {
    const runs = await rows('select * from daily_job_runs order by id');
    expect(runs.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------

describe('daily session selection adapts to the learner', () => {
  async function seedProgress(userId: string, wordIds: number[], nextReview: string, extra = '') {
    await db.query(
      `insert into vocabulary_progress (user_id, word_id, status, next_review_at, times_seen, times_correct, streak, last_seen_at ${extra ? ', times_incorrect' : ''})
       select $1, id, 'familiar', $2::timestamptz, 3, 3, 2, now() - interval '3 days' ${extra ? `, ${extra}` : ''}
         from vocabulary_words where id = any($3::int[])`,
      [userId, nextReview, wordIds],
    );
  }

  it('many overdue reviews -> 8 review + 2 new', async () => {
    const u = await createUser(db);
    const ids = (await rows(`select id from vocabulary_words where cefr_level = 'A1' order by id limit 30`)).map((r) => r.id);
    await seedProgress(u, ids, '2026-01-01T00:00:00Z');
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect([s.review_word_count, s.new_word_count, s.total_word_count]).toEqual([8, 2, 10]);
  });

  it('a few due reviews -> they are all included, the rest are new', async () => {
    const u = await createUser(db);
    const ids = (await rows(`select id from vocabulary_words order by id limit 4`)).map((r) => r.id);
    await seedProgress(u, ids, '2026-01-01T00:00:00Z');
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect([s.review_word_count, s.new_word_count]).toEqual([4, 6]);
  });

  it('frequently-wrong words come back early, at most two of them', async () => {
    const u = await createUser(db);
    const ids = (await rows(`select id from vocabulary_words order by id limit 5`)).map((r) => r.id);
    await seedProgress(u, ids, '2099-01-01T00:00:00Z', '4');
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect([s.review_word_count, s.new_word_count]).toEqual([2, 8]);
  });

  it('respects a custom daily target and never exceeds it', async () => {
    const u = await createUser(db, { target: 5 });
    const ids = (await rows(`select id from vocabulary_words order by id limit 40`)).map((r) => r.id);
    await seedProgress(u, ids, '2026-01-01T00:00:00Z');
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect(s.total_word_count).toBe(5);
    expect(s.new_word_count).toBe(1);
  });

  it('no new words left -> fills the target with the earliest upcoming reviews', async () => {
    const u = await createUser(db);
    const all = (await rows(`select id from vocabulary_words`)).map((r) => r.id);
    await seedProgress(u, all, '2099-01-01T00:00:00Z');
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect([s.review_word_count, s.new_word_count]).toEqual([10, 0]);
  });

  it('starts new words at the learner\'s CEFR level', async () => {
    const u = await createUser(db, { level: 'B1' });
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    const { items } = await loadSession(u, s.id);
    expect(items.every((i) => i.word.cefr_level === 'B1')).toBe(true);
  });

  it('uses the learner\'s timezone for "today"', async () => {
    const u = await createUser(db, { timezone: 'Pacific/Kiritimati' }); // UTC+14
    const s = await asUser(db, u, () => one('select session_date::text as d from create_my_daily_session()'));
    expect(s.d).toBe(localDate('Pacific/Kiritimati'));
  });

  it('the job skips users who have not finished onboarding', async () => {
    const u = await createUser(db, { onboard: false });
    await db.query('select public.run_daily_learning_job()');
    expect((await one('select count(*)::int as n from daily_sessions where user_id = $1', [u])).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('security (RLS + privileges)', () => {
  let alice: string;
  let bob: string;
  let aliceSession: Row;

  beforeAll(async () => {
    alice = await createUser(db);
    bob = await createUser(db);
    aliceSession = await asUser(db, alice, () => one('select * from create_my_daily_session()'));
    await takeQuiz(alice, aliceSession.id, new Date(), 1);
  });

  it('a user cannot read another user\'s profile, progress, sessions, quiz attempts or answers', async () => {
    await asUser(db, bob, async () => {
      for (const t of ['vocabulary_progress', 'daily_sessions', 'quiz_attempts']) {
        expect((await rows(`select * from ${t} where user_id = $1`, [alice])).length, t).toBe(0);
      }
      expect((await rows('select * from profiles where id = $1', [alice])).length).toBe(0);
      expect((await rows('select * from daily_session_words where session_id = $1', [aliceSession.id])).length).toBe(0);
      expect((await rows('select * from quiz_answers')).length).toBe(0);
    });
    // sanity: alice sees her own
    expect((await asUser(db, alice, () => rows('select * from vocabulary_progress'))).length).toBe(10);
  });

  it('a user cannot modify another user\'s profile', async () => {
    const r = await asUser(db, bob, () => rows(`update profiles set daily_word_target = 30 where id = $1 returning id`, [alice]));
    expect(r).toHaveLength(0);
  });

  it('a user cannot write progress or sessions directly, only through validated RPCs', async () => {
    await asUser(db, bob, async () => {
      await expect(db.query(`insert into vocabulary_progress (user_id, word_id) values ($1, 1)`, [bob])).rejects.toThrow(/permission denied/);
      await expect(db.query(`update vocabulary_progress set streak = 99`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`insert into daily_sessions (user_id, session_date, new_word_count, review_word_count, total_word_count) values ($1, '2030-01-01', 0, 0, 0)`, [bob])).rejects.toThrow(/permission denied/);
      await expect(db.query(`update profiles set id = $1`, [alice])).rejects.toThrow(/permission denied/);
    });
  });

  it('internal functions are not callable from the API', async () => {
    await asUser(db, bob, async () => {
      await expect(db.query('select create_daily_session_for($1, current_date)', [alice])).rejects.toThrow(/permission denied/);
      await expect(db.query('select run_daily_learning_job()')).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from daily_job_runs')).rejects.toThrow(/permission denied/);
    });
  });

  it('a user cannot submit a quiz for someone else\'s session', async () => {
    await asUser(db, bob, async () => {
      await expect(db.query(`select submit_quiz($1, 10, '[]'::jsonb, '[]'::jsonb)`, [aliceSession.id])).rejects.toThrow(/session not found/);
    });
  });

  it('signed-out (anon) visitors can read nothing', async () => {
    await asUser(db, null, async () => {
      await expect(db.query('select * from vocabulary_words')).rejects.toThrow(/permission denied/);
      await expect(db.query('select create_my_daily_session()')).rejects.toThrow(/permission denied/);
    });
  });

  it('submit_quiz rejects incomplete or tampered submissions', async () => {
    const s = await asUser(db, bob, () => one('select * from create_my_daily_session()'));
    const { items } = await loadSession(bob, s.id);
    const ans = (ids: number[]) => JSON.stringify(ids.map((word_id) => ({ word_id, question_type: 'de_en', user_answer: 'x', correct_answer: 'x', is_correct: true })));
    const sched = (ids: number[], at = new Date(Date.now() + 86400_000).toISOString()) =>
      JSON.stringify(ids.map((word_id) => ({ word_id, status: 'learning', streak: 1, difficulty: 0, next_review_at: at })));
    const ids = items.map((i) => i.word.id);
    const call = (a: string, sc: string) => asUser(db, bob, () => db.query('select submit_quiz($1, 10, $2::jsonb, $3::jsonb)', [s.id, a, sc]));

    await expect(call(ans(ids.slice(0, 9)), sched(ids.slice(0, 9)))).rejects.toThrow(/exactly once/);
    await expect(call(ans([...ids.slice(0, 9), 9999]), sched(ids))).rejects.toThrow(/exactly once/);
    await expect(call(ans(ids), sched(ids, '2020-01-01T00:00:00Z'))).rejects.toThrow(/invalid schedule/);
    await expect(call(ans(ids), sched(ids, '2099-01-01T00:00:00Z'))).rejects.toThrow(/invalid schedule/);
    // nothing was stored by the failed attempts
    expect((await asUser(db, bob, () => rows('select * from quiz_attempts'))).length).toBe(0);
    await expect(call(ans(ids), sched(ids))).resolves.toBeTruthy();
  });
});
