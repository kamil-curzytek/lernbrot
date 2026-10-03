import { describe, expect, it } from 'vitest';
import { applyAnswer, DEFAULT_SR_CONFIG, intervalForStreak, statusForStreak } from '../src/lib/spacedRepetition';
import { addDays, localDate, zonedMidnight } from '../src/lib/time';

const tz = 'Europe/Berlin';
const evening = new Date('2026-10-01T19:30:00Z'); // 21:30 in Berlin

describe('spaced repetition', () => {
  it('uses the configured interval ladder 1, 2, 4, 7, 14, 30, 60 days', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((s) => intervalForStreak(s))).toEqual([1, 2, 4, 7, 14, 30, 60, 60]);
  });

  it('first correct answer: due at local midnight tomorrow, status learning', () => {
    const r = applyAnswer(null, true, { now: evening, timeZone: tz });
    expect(r.streak).toBe(1);
    expect(r.intervalDays).toBe(1);
    expect(r.status).toBe('learning');
    expect(r.next_review_at).toBe('2026-10-01T22:00:00.000Z'); // 2026-10-02 00:00 CEST
  });

  it('correct answers increase the interval', () => {
    let prev = { streak: 0, difficulty: 0 };
    const intervals: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = applyAnswer(prev, true, { now: evening, timeZone: tz });
      intervals.push(r.intervalDays);
      prev = r;
    }
    expect(intervals).toEqual([1, 2, 4, 7, 14, 30, 60]);
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]).toBeGreaterThan(intervals[i - 1]);
  });

  it('incorrect answers shorten the interval, reduce the streak and set status learning', () => {
    const strong = { streak: 5, difficulty: 1 };
    const correct = applyAnswer(strong, true, { now: evening, timeZone: tz });
    const wrong = applyAnswer(strong, false, { now: evening, timeZone: tz });
    expect(correct.intervalDays).toBe(30);
    expect(wrong.intervalDays).toBe(1);
    expect(wrong.intervalDays).toBeLessThan(correct.intervalDays);
    expect(wrong.streak).toBe(2); // floor(5 * 0.5)
    expect(wrong.status).toBe('learning');
    expect(wrong.difficulty).toBe(3);
  });

  it('a new word answered wrong comes back tomorrow', () => {
    const r = applyAnswer(null, false, { now: evening, timeZone: tz });
    expect(r.streak).toBe(0);
    expect(r.next_review_at).toBe(zonedMidnight(addDays(localDate(tz, evening), 1), tz).toISOString());
  });

  it('progresses learning -> familiar -> strong', () => {
    expect([1, 2, 3, 4, 6].map((s) => statusForStreak(s))).toEqual(['learning', 'familiar', 'familiar', 'strong', 'strong']);
  });

  it('is configurable', () => {
    const config = { ...DEFAULT_SR_CONFIG, intervalsDays: [3, 10], lapseStreakFactor: 0 };
    expect(applyAnswer(null, true, { now: evening, timeZone: tz }, config).intervalDays).toBe(3);
    expect(applyAnswer({ streak: 6, difficulty: 0 }, false, { now: evening, timeZone: tz }, config).streak).toBe(0);
  });

  it('schedules by the learner\'s local day, across timezones and DST', () => {
    // 23:30 UTC on Oct 1 is already Oct 2 in Tokyo -> due Oct 3 00:00 JST
    const r = applyAnswer(null, true, { now: new Date('2026-10-01T23:30:00Z'), timeZone: 'Asia/Tokyo' });
    expect(r.next_review_at).toBe('2026-10-02T15:00:00.000Z');
    // Berlin DST ends 2026-10-25: midnight Oct 26 is 23:00 UTC (CET)
    expect(zonedMidnight('2026-10-26', tz).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(zonedMidnight('2026-10-25', tz).toISOString()).toBe('2026-10-24T22:00:00.000Z');
  });
});
