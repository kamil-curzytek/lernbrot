// Integration tests: real migrations + seed on Postgres (PGlite), exercising the
// SQL functions the app and the cloud job call, together with the TypeScript
// quiz engine and spaced repetition, through the MVP definition-of-done loop.
import type { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSubmission, generateQuiz, type QuizQuestion } from '../src/lib/quiz';
import type { ProgressSnapshot } from '../src/lib/spacedRepetition';
import { addDays, daysBetween, localDate, zonedMidnight } from '../src/lib/time';
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
    // words recognised once must now be recalled (typed), not recognised again
    const known = reviewIds.filter((id) => !day1Missed.includes(id));
    for (const id of known) expect(levelOf.get(id)).toBeGreaterThanOrEqual(3);

    // correct twice in a row -> familiar; FSRS memory state stored and the gap grows beyond a day
    const p = await asUser(db, userId, () => one('select * from vocabulary_progress where word_id = $1', [known[0]]));
    expect(p.status).toBe('familiar');
    expect(p.streak).toBe(2);
    expect(p.stability).toBeGreaterThan(1.3);
    expect(p.fsrs_difficulty).toBeGreaterThanOrEqual(1);
    expect(p.last_review_at).not.toBeNull();
    const gap = daysBetween(tomorrow, localDate(TZ, new Date(p.next_review_at)));
    expect(gap).toBeGreaterThanOrEqual(2);
    expect(new Date(p.next_review_at).getTime()).toBe(zonedMidnight(addDays(tomorrow, gap), TZ).getTime());
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

  it('a few more reviews due than fit -> 8 review + 2 new', async () => {
    const u = await createUser(db);
    const ids = (await rows(`select id from vocabulary_words where cefr_level = 'A1' order by id limit 9`)).map((r) => r.id);
    await seedProgress(u, ids, '2026-01-01T00:00:00Z');
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect([s.review_word_count, s.new_word_count, s.total_word_count]).toEqual([8, 2, 10]);
  });

  it('due reviews: the word most likely forgotten comes first (lowest FSRS predicted recall)', async () => {
    const u = await createUser(db);
    const ids = (await rows(`select id from vocabulary_words where cefr_level = 'A1' order by id limit 15`)).map((r) => r.id);
    await seedProgress(u, ids, '2026-01-01T00:00:00Z');
    // all equally overdue; the last word (by id) has by far the weakest memory
    await db.query(`update vocabulary_progress set stability = 100, fsrs_difficulty = 5, last_review_at = now() - interval '3 days' where user_id = $1`, [u]);
    await db.query(`update vocabulary_progress set stability = 0.5 where user_id = $1 and word_id = $2`, [u, ids[14]]);
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    const reviews = await rows(`select word_id from daily_session_words where session_id = $1 and kind = 'review' order by position`, [s.id]);
    expect(reviews.length).toBe(9);
    expect(reviews[0].word_id).toBe(ids[14]); // picked first, although only 9 of the 15 due words fit
  });

  it('a submission without memory state (app from before the update) is accepted and keeps the stored state', async () => {
    const u = await createUser(db);
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    const words = await rows('select word_id from daily_session_words where session_id = $1', [s.id]);
    const ids = words.map((w) => w.word_id);
    await db.query(
      `insert into vocabulary_progress (user_id, word_id, status, streak, stability, fsrs_difficulty, last_review_at, last_seen_at, next_review_at)
       values ($1, $2, 'learning', 1, 9.5, 4, now() - interval '9 days', now() - interval '9 days', now() - interval '1 day')`,
      [u, ids[0]],
    );
    const at = new Date(Date.now() + 86400_000).toISOString();
    const answers = JSON.stringify(ids.map((word_id) => ({ word_id, question_type: 'de_en', user_answer: 'x', correct_answer: 'x', is_correct: true })));
    const legacy = JSON.stringify(ids.map((word_id) => ({ word_id, status: 'learning', streak: 1, difficulty: 0, next_review_at: at })));
    await asUser(db, u, () => db.query('select submit_quiz($1, 10, $2::jsonb, $3::jsonb)', [s.id, answers, legacy]));
    const kept = await one('select * from vocabulary_progress where user_id = $1 and word_id = $2', [u, ids[0]]);
    expect(kept.stability).toBe(9.5);
    expect(kept.fsrs_difficulty).toBe(4);
    const fresh = await one('select * from vocabulary_progress where user_id = $1 and word_id = $2', [u, ids[1]]);
    expect(fresh.stability).toBeNull();
    expect(fresh.last_review_at).toBeNull();
  });

  it('migration 0006 gives existing progress an FSRS memory state from its old schedule (idempotent)', async () => {
    const u = await createUser(db);
    const [w] = (await rows(`select id from vocabulary_words where cefr_level = 'A1' order by id limit 1`)).map((r) => r.id);
    await seedProgress(u, [w], new Date(Date.now() + 4 * 86400_000).toISOString()); // seen 3 days ago, due in 4 -> 7-day interval
    await db.query(`update vocabulary_progress set difficulty = 4 where user_id = $1`, [u]);
    const migration = readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', '20261006000006_fsrs.sql'), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    // re-running 0006 replaced functions that later migrations redefine: restore the latest versions
    const dir = join(import.meta.dirname, '..', 'supabase', 'migrations');
    for (const f of readdirSync(dir).sort()) if (f > '20261006000006_fsrs.sql' && !f.includes('cron')) await db.exec(readFileSync(join(dir, f), 'utf8'));
    const p = await one('select * from vocabulary_progress where user_id = $1', [u]);
    expect(p.stability).toBe(7);
    expect(p.fsrs_difficulty).toBeCloseTo(3 + 0.7 * 4);
    expect(p.last_review_at).toEqual(p.last_seen_at);
  });

  it('busy day (1-2x the target due) -> 9 review + 1 new', async () => {
    const u = await createUser(db);
    const ids = (await rows(`select id from vocabulary_words where cefr_level = 'A1' order by id limit 15`)).map((r) => r.id);
    await seedProgress(u, ids, '2026-01-01T00:00:00Z');
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect([s.review_word_count, s.new_word_count, s.total_word_count]).toEqual([9, 1, 10]);
  });

  it('catch-up day (2x the target or more due) -> only reviews, no new words', async () => {
    const u = await createUser(db);
    const ids = (await rows(`select id from vocabulary_words where cefr_level = 'A1' order by id limit 30`)).map((r) => r.id);
    await seedProgress(u, ids, '2026-01-01T00:00:00Z');
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect([s.review_word_count, s.new_word_count, s.total_word_count]).toEqual([10, 0, 10]);
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
    expect(s.new_word_count).toBe(0); // 40 due = catch-up day
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
    const sched = (ids: number[], at = new Date(Date.now() + 86400_000).toISOString(), extra: Record<string, unknown> = {}) =>
      JSON.stringify(ids.map((word_id) => ({ word_id, status: 'learning', streak: 1, difficulty: 0, next_review_at: at, stability: 1.3, fsrs_difficulty: 5, ...extra })));
    const ids = items.map((i) => i.word.id);
    const call = (a: string, sc: string) => asUser(db, bob, () => db.query('select submit_quiz($1, 10, $2::jsonb, $3::jsonb)', [s.id, a, sc]));

    await expect(call(ans(ids.slice(0, 9)), sched(ids.slice(0, 9)))).rejects.toThrow(/exactly once/);
    await expect(call(ans([...ids.slice(0, 9), 9999]), sched(ids))).rejects.toThrow(/exactly once/);
    await expect(call(ans(ids), sched(ids, '2020-01-01T00:00:00Z'))).rejects.toThrow(/invalid schedule/);
    await expect(call(ans(ids), sched(ids, '2099-01-01T00:00:00Z'))).rejects.toThrow(/invalid schedule/);
    // the FSRS memory state must be complete and within bounds
    const tomorrowIso = new Date(Date.now() + 86400_000).toISOString();
    await expect(call(ans(ids), sched(ids, tomorrowIso, { stability: null }))).rejects.toThrow(/invalid schedule/);
    await expect(call(ans(ids), sched(ids, tomorrowIso, { stability: 0 }))).rejects.toThrow(/invalid schedule/);
    await expect(call(ans(ids), sched(ids, tomorrowIso, { fsrs_difficulty: 11 }))).rejects.toThrow(/invalid schedule/);
    // nothing was stored by the failed attempts
    expect((await asUser(db, bob, () => rows('select * from quiz_attempts'))).length).toBe(0);
    await expect(call(ans(ids), sched(ids))).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('resume where you left off', () => {
  let u: string;
  let other: string;
  let s: Row;

  beforeAll(async () => {
    u = await createUser(db);
    other = await createUser(db);
    s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
  });

  const save = (user: string, args: { pos?: number; q?: string; a?: string }) =>
    asUser(db, user, () =>
      db.query('select save_session_progress($1, $2, $3, $4)', [s.id, args.pos ?? null, args.q ?? null, args.a ?? null]),
    );
  const reload = () => asUser(db, u, () => one('select * from daily_sessions where id = $1', [s.id]));

  it('saves the study card position after each card, and it only moves forward', async () => {
    await save(u, { pos: 4 });
    expect((await reload()).study_position).toBe(4);
    await save(u, { pos: 2 }); // going back a card doesn't lose the furthest point
    expect((await reload()).study_position).toBe(4);
    await save(u, { pos: 99 });
    expect((await reload()).study_position).toBe(10); // capped at the number of words
  });

  it('saves each quiz answer and never overwrites one already given', async () => {
    const { items } = await loadSession(u, s.id);
    const [w1, w2] = items.map((i) => i.word.id);
    await save(u, { q: `${w1}:de_en`, a: 'appointment' });
    await save(u, { q: `${w2}:article`, a: 'der' });
    await save(u, { q: `${w1}:de_en`, a: 'changed my mind' });
    const draft = (await reload()).quiz_draft;
    expect(draft.answers).toEqual({ [`${w1}:de_en`]: 'appointment', [`${w2}:article`]: 'der' });
    expect(draft.startedAt).toBeTruthy();
  });

  it('rejects answers for words outside the session, and other users', async () => {
    await expect(save(u, { q: '999999:de_en', a: 'x' })).rejects.toThrow(/invalid answer/);
    await expect(save(u, { q: "1; drop table x", a: 'x' })).rejects.toThrow(/invalid answer/);
    await expect(save(other, { pos: 3 })).rejects.toThrow(/session not found/);
  });

  it('a resumed quiz is identical, so saved answers still match their questions', async () => {
    const { items, pool } = await loadSession(u, s.id);
    const quizItems = items.map((i) => ({ word: i.word, progress: i.progress }));
    expect(generateQuiz(quizItems, pool, s.id)).toEqual(generateQuiz(quizItems, pool, s.id));
  });

  it('nothing can be saved once the quiz is submitted', async () => {
    await takeQuiz(u, s.id, new Date(), 0);
    await expect(save(u, { pos: 1 })).rejects.toThrow(/already completed/);
  });
});

describe('words per day: 5 to 50 in steps of 5', () => {
  const setTarget = (user: string, n: number) => asUser(db, user, () => one('select update_daily_target($1) as r', [n]));

  it('accepts 5, 10 … 50 and rejects anything else', async () => {
    const u = await createUser(db);
    for (const n of [5, 25, 50]) expect((await setTarget(u, n)).r.profile.daily_word_target).toBe(n);
    for (const n of [0, 3, 7, 55, 100]) await expect(setTarget(u, n)).rejects.toThrow(/check constraint/);
    // the direct profile update is held to the same rule
    await expect(asUser(db, u, () => db.query('update profiles set daily_word_target = 12 where id = auth.uid()'))).rejects.toThrow(/check constraint/);
  });

  it('rebuilds today\'s lesson right away if it has not been started', async () => {
    const u = await createUser(db);
    const before = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect(before.total_word_count).toBe(10);
    const r = (await setTarget(u, 25)).r;
    expect(r.today_updated).toBe(true);
    const after = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect(after.total_word_count).toBe(25);
    expect((await one('select count(*)::int as n from daily_session_words where session_id = $1', [after.id])).n).toBe(25);
  });

  it('keeps today\'s lesson as it is once started, and applies from the next day', async () => {
    const u = await createUser(db);
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    await asUser(db, u, () => db.query('select save_session_progress($1, 1)', [s.id]));
    const r = (await setTarget(u, 40)).r;
    expect(r.today_updated).toBe(false);
    expect((await asUser(db, u, () => one('select * from create_my_daily_session()'))).total_word_count).toBe(10);
    const tomorrow = addDays(localDate(TZ), 1);
    const next = await one('select * from create_daily_session_for($1, $2)', [u, tomorrow]);
    expect(next.total_word_count).toBe(40);
  });

  it('works with 50 words: the quiz has 50 questions, one per word', async () => {
    const u = await createUser(db, { target: 50 });
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect(s.total_word_count).toBe(50);
    const { quiz, attempt } = await takeQuiz(u, s.id, new Date(), 5);
    expect(quiz).toHaveLength(50);
    expect(attempt.score).toBe(45);
  });
});

// ---------------------------------------------------------------------------

describe('grammar practice (migration 0007)', () => {
  const study = (u: string, ids: number[]) => asUser(db, u, () => one('select record_grammar_study($1::int[]) as n', [ids]));
  const skillsOf = async (topicSlug: string) =>
    (await rows(`select s.id from grammar_skills s join grammar_topics t on t.id = s.topic_id where t.slug = $1 order by s.id`, [topicSlug])).map((r) => r.id);

  it('seeds a grammar skill for every lesson topic', async () => {
    const n = await one(`select count(*)::int as n from grammar_topics t where not exists (select 1 from grammar_skills s where s.topic_id = t.id)`);
    expect(n.n).toBe(0);
    expect((await one('select count(*)::int as n from grammar_skills')).n).toBeGreaterThanOrEqual(60);
  });

  it('studying a skill puts it in the reviews from tomorrow (local midnight); repeating changes nothing', async () => {
    const u = await createUser(db);
    const [a, b] = await skillsOf('dative');
    expect((await study(u, [a, b])).n).toBe(2);
    expect((await study(u, [a])).n).toBe(0);
    const p = await one('select * from grammar_progress where user_id = $1 and skill_id = $2', [u, a]);
    const today = localDate(TZ, new Date());
    expect(new Date(p.next_review_at).getTime()).toBe(zonedMidnight(addDays(today, 1), TZ).getTime());
    expect(p.stability).toBeNull();
    await expect(study(u, [])).rejects.toThrow(/invalid skills/);
    await expect(study(u, [9999])).rejects.toThrow(/unknown skill/);
    await expect(asUser(db, null, () => db.query('select record_grammar_study($1::int[])', [[a]]))).rejects.toThrow(/permission denied/);
  });

  it('due skills join the daily session: at most 3, one per topic first, nothing if none is due', async () => {
    const u = await createUser(db);
    const dative = await skillsOf('dative');
    const acc = await skillsOf('accusative');
    const art = await skillsOf('articles');
    await study(u, [...dative, ...acc, ...art]);
    // nothing due yet (first review is tomorrow) -> no grammar today
    const s0 = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    expect((await rows('select * from daily_session_grammar where session_id = $1', [s0.id])).length).toBe(0);
    // make all due for tomorrow's session
    await db.query(`update grammar_progress set next_review_at = now() - interval '1 day' where user_id = $1`, [u]);
    const tomorrow = addDays(localDate(TZ, new Date()), 1);
    const s1 = await one('select * from create_daily_session_for($1, $2)', [u, tomorrow]);
    const g = await rows(
      `select sg.skill_id, s.topic_id from daily_session_grammar sg join grammar_skills s on s.id = sg.skill_id
        where sg.session_id = $1 order by sg.position`, [s1.id]);
    expect(g.length).toBe(3);
    expect(new Set(g.map((x) => x.topic_id)).size).toBe(3); // mixed: three different lessons
    // vocabulary is unaffected: grammar is extra to the words-per-day target
    expect(s1.total_word_count).toBe(10);
  });

  it('grammar answers can be saved for resume, but only for skills of that session', async () => {
    const u = await createUser(db);
    const [skill] = await skillsOf('perfekt');
    await study(u, [skill]);
    await db.query(`update grammar_progress set next_review_at = now() - interval '1 day' where user_id = $1`, [u]);
    const s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
    const save = (q: string) => asUser(db, u, () => db.query('select save_session_progress($1, null, $2, $3)', [s.id, q, 'x']));
    await save(`g${skill}:2`);
    const draft = (await one('select quiz_draft from daily_sessions where id = $1', [s.id])).quiz_draft;
    expect(draft.answers[`g${skill}:2`]).toBe('x');
    await expect(save('g1011:1')).rejects.toThrow(/invalid answer/); // not in this session
    await expect(save('gxx:1')).rejects.toThrow(/invalid answer/);
  });

  describe('submit_grammar_review', () => {
    let u: string;
    let s: Row;
    let skills: number[];
    const entry = (skill_id: number, over: Record<string, unknown> = {}) => ({
      skill_id, item_id: `${skill_id}:1`, user_answer: 'dem', correct_answer: 'dem', is_correct: true, error_category: 'case',
      status: 'learning', streak: 1, stability: 1.3, fsrs_difficulty: 5,
      next_review_at: new Date(Date.now() + 2 * 86400_000).toISOString(), ...over,
    });
    const submit = (entries: unknown[]) =>
      asUser(db, u, () => one('select submit_grammar_review($1, $2::jsonb) as n', [s.id, JSON.stringify(entries)]));

    beforeAll(async () => {
      u = await createUser(db);
      skills = [...(await skillsOf('dative')).slice(0, 1), ...(await skillsOf('accusative')).slice(0, 1)];
      await study(u, skills);
      await db.query(`update grammar_progress set next_review_at = now() - interval '1 day' where user_id = $1`, [u]);
      s = await asUser(db, u, () => one('select * from create_my_daily_session()'));
      const inSession = (await rows('select skill_id from daily_session_grammar where session_id = $1 order by position', [s.id])).map((r) => r.skill_id);
      expect(inSession.sort()).toEqual([...skills].sort());
    });

    it('rejects incomplete, foreign or out-of-range entries', async () => {
      await expect(submit([entry(skills[0])])).rejects.toThrow(/exactly once/);
      await expect(submit([entry(skills[0]), entry(1011)])).rejects.toThrow(/exactly once/);
      await expect(submit([entry(skills[0], { item_id: `${skills[0]}:99` }), entry(skills[1])])).rejects.toThrow(/invalid grammar entries/);
      await expect(submit([entry(skills[0], { item_id: `${skills[1]}:1` }), entry(skills[1])])).rejects.toThrow(/invalid grammar entries/);
      await expect(submit([entry(skills[0], { error_category: 'spelling' }), entry(skills[1])])).rejects.toThrow(/invalid grammar entries/);
      await expect(submit([entry(skills[0], { stability: 0 }), entry(skills[1])])).rejects.toThrow(/invalid grammar entries/);
      await expect(submit([entry(skills[0], { next_review_at: '2020-01-01T00:00:00Z' }), entry(skills[1])])).rejects.toThrow(/invalid grammar entries/);
      expect((await asUser(db, u, () => rows('select * from grammar_answers'))).length).toBe(0);
    });

    it('stores answers with their category, updates the FSRS state, and only once', async () => {
      const score = await submit([entry(skills[0]), entry(skills[1], { is_correct: false, user_answer: 'den', streak: 0 })]);
      expect(score.n).toBe(1);
      const answers = await asUser(db, u, () => rows('select * from grammar_answers order by skill_id'));
      expect(answers.length).toBe(2);
      expect(answers.every((a) => a.error_category === 'case')).toBe(true);
      const p = await one('select * from grammar_progress where user_id = $1 and skill_id = $2', [u, skills[0]]);
      expect(p.stability).toBeCloseTo(1.3);
      expect(p.times_correct).toBe(1);
      expect(p.last_review_at).not.toBeNull();
      const p2 = await one('select * from grammar_progress where user_id = $1 and skill_id = $2', [u, skills[1]]);
      expect(p2.times_incorrect).toBe(1);
      expect((await one('select grammar_completed_at from daily_sessions where id = $1', [s.id])).grammar_completed_at).not.toBeNull();
      await expect(submit([entry(skills[0]), entry(skills[1])])).rejects.toThrow(/already submitted/);
    });

    it('other users cannot read grammar progress, answers or session grammar', async () => {
      const other = await createUser(db);
      expect((await asUser(db, other, () => rows('select * from grammar_progress'))).length).toBe(0);
      expect((await asUser(db, other, () => rows('select * from grammar_answers'))).length).toBe(0);
      expect((await asUser(db, other, () => rows('select * from daily_session_grammar'))).length).toBe(0);
      await expect(asUser(db, other, () => db.query('select submit_grammar_review($1, $2::jsonb)', [s.id, '[]']))).rejects.toThrow(/session not found/);
      await expect(asUser(db, u, () => db.query(`insert into grammar_progress (user_id, skill_id, next_review_at) values ($1, 1011, now())`, [u]))).rejects.toThrow(/permission denied/);
    });
  });
});
