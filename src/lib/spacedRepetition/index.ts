// Spaced repetition with the FSRS-6 memory model (ts-fsrs, default parameters).
// Pure functions only: no I/O, no randomness (fuzz is off), so every device computes the same schedule.
//
// Each word carries a memory state: stability (days until predicted recall falls to 90 %) and
// difficulty (1..10). One scored answer per word per day updates it; the next review is scheduled
// for local midnight of the day when predicted recall reaches the requested retention.
// Why FSRS and not fixed gaps: research/review-strategy/review-strategy.md.

import { FSRSAlgorithm, Rating, type Grade } from 'ts-fsrs';
import type { ProgressStatus, VocabularyProgress } from '../../types';
import { addDays, daysBetween, localDate, zonedMidnight } from '../time';
import { DEFAULT_SR_CONFIG, type SpacedRepetitionConfig } from './config';

export { DEFAULT_SR_CONFIG, type SpacedRepetitionConfig } from './config';

/** What the scheduler needs from a word's stored progress. Missing memory state = never scored. */
export type ProgressSnapshot = Pick<VocabularyProgress, 'streak' | 'difficulty'> &
  Partial<Pick<VocabularyProgress, 'stability' | 'fsrs_difficulty' | 'last_review_at' | 'last_seen_at'>>;

/** How the word was answered. Recognising it among options is weaker evidence than recalling it. */
export interface AnswerOutcome {
  correct: boolean;
  format: 'choice' | 'typed';
}

export interface ScheduleUpdate {
  status: Exclude<ProgressStatus, 'new' | 'review'>;
  streak: number;
  difficulty: number;
  stability: number;
  fsrs_difficulty: number;
  intervalDays: number;
  next_review_at: string; // ISO timestamp
}

export interface ScheduleContext {
  now: Date;
  timeZone: string;
}

const algorithms = new Map<string, FSRSAlgorithm>();
function algorithm(config: SpacedRepetitionConfig): FSRSAlgorithm {
  const key = `${config.requestRetention}/${config.maximumIntervalDays}`;
  let a = algorithms.get(key);
  if (!a) {
    a = new FSRSAlgorithm({
      request_retention: config.requestRetention,
      maximum_interval: config.maximumIntervalDays,
      enable_fuzz: false,
      enable_short_term: true,
    });
    algorithms.set(key, a);
  }
  return a;
}

/** Wrong = Again; correct multiple choice = Hard (recognition); correct typed recall = Good. */
export function gradeFor(outcome: AnswerOutcome): Grade {
  if (!outcome.correct) return Rating.Again;
  return outcome.format === 'typed' ? Rating.Good : Rating.Hard;
}

export function statusForStreak(
  streak: number,
  config: SpacedRepetitionConfig = DEFAULT_SR_CONFIG,
): ScheduleUpdate['status'] {
  if (streak >= config.strongAtStreak) return 'strong';
  if (streak >= config.familiarAtStreak) return 'familiar';
  return 'learning';
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Whole local days since the last scored review (0 if none or in the future). */
function elapsedDays(prev: ProgressSnapshot | null, ctx: ScheduleContext): number {
  const last = prev?.last_review_at ?? prev?.last_seen_at;
  if (!last) return 0;
  return Math.max(0, daysBetween(localDate(ctx.timeZone, new Date(last)), localDate(ctx.timeZone, ctx.now)));
}

/** Next schedule for a word after one scored quiz answer. `prev` is null for a word never quizzed. */
export function applyAnswer(
  prev: ProgressSnapshot | null,
  outcome: AnswerOutcome,
  ctx: ScheduleContext,
  config: SpacedRepetitionConfig = DEFAULT_SR_CONFIG,
): ScheduleUpdate {
  const fsrs = algorithm(config);
  const hasState = prev?.stability != null && prev?.fsrs_difficulty != null;
  const t = hasState ? elapsedDays(prev, ctx) : 0;
  const state = fsrs.next_state(
    hasState ? { stability: prev!.stability!, difficulty: prev!.fsrs_difficulty! } : null,
    t,
    gradeFor(outcome),
  );

  const prevStreak = prev?.streak ?? 0;
  const prevDifficulty = prev?.difficulty ?? 0;
  let streak: number;
  let difficulty: number;
  let intervalDays: number;
  if (outcome.correct) {
    streak = prevStreak + 1;
    difficulty = clamp(prevDifficulty + config.difficultyOnCorrect, 0, config.maxDifficulty);
    intervalDays = fsrs.next_interval(state.stability, t);
  } else {
    streak = Math.floor(prevStreak * config.lapseStreakFactor);
    difficulty = clamp(prevDifficulty + config.difficultyOnIncorrect, 0, config.maxDifficulty);
    intervalDays = config.lapseIntervalDays;
  }
  intervalDays = clamp(Math.round(intervalDays), 1, config.maximumIntervalDays);

  const today = localDate(ctx.timeZone, ctx.now);
  const next = zonedMidnight(addDays(today, intervalDays), ctx.timeZone);
  return {
    status: outcome.correct ? statusForStreak(streak, config) : 'learning',
    streak,
    difficulty,
    stability: round4(state.stability),
    fsrs_difficulty: round4(clamp(state.difficulty, 1, 10)),
    intervalDays,
    next_review_at: next.toISOString(),
  };
}

/**
 * Gaps (days) a typical word gets: recognised on day one, then recalled every time it is due.
 * Used to explain the schedule (About page); computed by the real scheduler so the text can't drift.
 */
export function typicalGaps(count = 7, config: SpacedRepetitionConfig = DEFAULT_SR_CONFIG): number[] {
  const tz = 'UTC';
  let now = new Date('2026-01-01T12:00:00Z');
  let prev: ProgressSnapshot | null = null;
  const gaps: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = applyAnswer(prev, { correct: true, format: i === 0 ? 'choice' : 'typed' }, { now, timeZone: tz }, config);
    gaps.push(r.intervalDays);
    prev = { ...r, last_review_at: now.toISOString() };
    now = new Date(Date.parse(r.next_review_at) + 12 * 3_600_000);
  }
  return gaps;
}
