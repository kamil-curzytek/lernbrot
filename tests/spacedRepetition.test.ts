import { describe, expect, it } from 'vitest';
import { applyAnswer, DEFAULT_SR_CONFIG, gradeFor, statusForStreak, typicalGaps, type ProgressSnapshot } from '../src/lib/spacedRepetition';
import { addDays, localDate, zonedMidnight } from '../src/lib/time';

const tz = 'Europe/Berlin';
const evening = new Date('2026-10-01T19:30:00Z'); // 21:30 in Berlin
const ctx = { now: evening, timeZone: tz };
const typedRight = { correct: true, format: 'typed' } as const;
const choiceRight = { correct: true, format: 'choice' } as const;
const wrong = { correct: false, format: 'typed' } as const;

function daysAfter(base: Date, days: number) {
  return new Date(base.getTime() + days * 86_400_000);
}

describe('spaced repetition (FSRS-6)', () => {
  it('grades: wrong = Again, recognised = Hard, recalled = Good', () => {
    expect(gradeFor(wrong)).toBe(1);
    expect(gradeFor(choiceRight)).toBe(2);
    expect(gradeFor(typedRight)).toBe(3);
  });

  it('new word recognised: due at local midnight tomorrow, with an initial memory state', () => {
    const r = applyAnswer(null, choiceRight, ctx);
    expect(r.streak).toBe(1);
    expect(r.intervalDays).toBe(1);
    expect(r.status).toBe('learning');
    expect(r.next_review_at).toBe('2026-10-01T22:00:00.000Z'); // 2026-10-02 00:00 CEST
    expect(r.stability).toBeGreaterThan(0);
    expect(r.fsrs_difficulty).toBeGreaterThanOrEqual(1);
    expect(r.fsrs_difficulty).toBeLessThanOrEqual(10);
  });

  it('recall is stronger evidence than recognition', () => {
    const recog = applyAnswer(null, choiceRight, ctx);
    const recall = applyAnswer(null, typedRight, ctx);
    expect(recall.stability).toBeGreaterThan(recog.stability);
    expect(recall.intervalDays).toBeGreaterThanOrEqual(recog.intervalDays);
  });

  it('gaps keep growing past the old 60-day ceiling, up to the configured maximum', () => {
    const gaps = typicalGaps(10);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    expect(gaps.some((g) => g > 60)).toBe(true);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(DEFAULT_SR_CONFIG.maximumIntervalDays);
    expect(gaps[0]).toBe(1);
  });

  it('a wrong answer brings the word back tomorrow, halves the streak and lowers stability', () => {
    const strong: ProgressSnapshot = { streak: 5, difficulty: 1, stability: 40, fsrs_difficulty: 5, last_review_at: daysAfter(evening, -40).toISOString() };
    const ok = applyAnswer(strong, typedRight, ctx);
    const no = applyAnswer(strong, wrong, ctx);
    expect(no.intervalDays).toBe(1);
    expect(no.next_review_at).toBe(zonedMidnight(addDays(localDate(tz, evening), 1), tz).toISOString());
    expect(no.streak).toBe(2); // floor(5 * 0.5)
    expect(no.status).toBe('learning');
    expect(no.stability).toBeLessThan(40);
    expect(ok.stability).toBeGreaterThan(40);
    expect(ok.intervalDays).toBeGreaterThan(40);
    expect(no.difficulty).toBe(3);
  });

  it('a late review that is still remembered earns a longer gap than an on-time one', () => {
    const base = { streak: 5, difficulty: 0, stability: 40, fsrs_difficulty: 5 };
    const onTime = applyAnswer({ ...base, last_review_at: daysAfter(evening, -40).toISOString() }, typedRight, ctx);
    const late = applyAnswer({ ...base, last_review_at: daysAfter(evening, -150).toISOString() }, typedRight, ctx);
    expect(late.intervalDays).toBeGreaterThan(onTime.intervalDays);
  });

  it('a word without a stored memory state starts fresh (legacy / first answer)', () => {
    const legacy = applyAnswer({ streak: 3, difficulty: 2 }, typedRight, ctx);
    const fresh = applyAnswer(null, typedRight, ctx);
    expect(legacy.stability).toBe(fresh.stability);
    expect(legacy.streak).toBe(4); // streak keeps counting for question difficulty and status
  });

  it('progresses learning -> familiar -> strong by streak', () => {
    expect([1, 2, 3, 4, 6].map((s) => statusForStreak(s))).toEqual(['learning', 'familiar', 'familiar', 'strong', 'strong']);
  });

  it('is configurable: lower requested retention gives longer gaps', () => {
    const prev = { streak: 3, difficulty: 0, stability: 20, fsrs_difficulty: 5, last_review_at: daysAfter(evening, -20).toISOString() };
    const at90 = applyAnswer(prev, typedRight, ctx);
    const at80 = applyAnswer(prev, typedRight, ctx, { ...DEFAULT_SR_CONFIG, requestRetention: 0.8 });
    expect(at80.intervalDays).toBeGreaterThan(at90.intervalDays);
    const capped = applyAnswer(prev, typedRight, ctx, { ...DEFAULT_SR_CONFIG, maximumIntervalDays: 10 });
    expect(capped.intervalDays).toBe(10);
  });

  it('is deterministic (no fuzz): same input, same schedule', () => {
    const prev = { streak: 2, difficulty: 0, stability: 6, fsrs_difficulty: 4, last_review_at: daysAfter(evening, -6).toISOString() };
    expect(applyAnswer(prev, typedRight, ctx)).toEqual(applyAnswer(prev, typedRight, ctx));
  });

  it("schedules by the learner's local day, across timezones and DST", () => {
    // 23:30 UTC on Oct 1 is already Oct 2 in Tokyo -> recognised new word due Oct 3 00:00 JST
    const r = applyAnswer(null, choiceRight, { now: new Date('2026-10-01T23:30:00Z'), timeZone: 'Asia/Tokyo' });
    expect(r.next_review_at).toBe('2026-10-02T15:00:00.000Z');
    // elapsed days are counted in local days: reviewed late on Oct 1, answered early on Oct 2 = 1 day
    const prev = { streak: 1, difficulty: 0, stability: 1.3, fsrs_difficulty: 5, last_review_at: '2026-10-01T21:50:00Z' }; // 23:50 Berlin
    const nextMorning = applyAnswer(prev, typedRight, { now: new Date('2026-10-02T05:00:00Z'), timeZone: tz });
    const sameDay = applyAnswer(prev, typedRight, { now: new Date('2026-10-01T21:55:00Z'), timeZone: tz });
    expect(nextMorning.stability).not.toBe(sameDay.stability);
    // Berlin DST ends 2026-10-25: midnight Oct 26 is 23:00 UTC (CET)
    expect(zonedMidnight('2026-10-26', tz).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(zonedMidnight('2026-10-25', tz).toISOString()).toBe('2026-10-24T22:00:00.000Z');
  });
});
