// Deterministic spaced repetition. Pure functions only: no I/O, no randomness.
//
// Reviews are scheduled for local midnight of a future learning day, so a word
// with a 1-day interval is due in tomorrow's session no matter what time of day
// today's quiz was taken.

import type { ProgressStatus, VocabularyProgress } from '../../types';
import { addDays, localDate, zonedMidnight } from '../time';
import { DEFAULT_SR_CONFIG, type SpacedRepetitionConfig } from './config';

export { DEFAULT_SR_CONFIG, type SpacedRepetitionConfig } from './config';

export type ProgressSnapshot = Pick<VocabularyProgress, 'streak' | 'difficulty'>;

export interface ScheduleUpdate {
  status: Exclude<ProgressStatus, 'new' | 'review'>;
  streak: number;
  difficulty: number;
  intervalDays: number;
  next_review_at: string; // ISO timestamp
}

export interface ScheduleContext {
  now: Date;
  timeZone: string;
}

export function intervalForStreak(streak: number, config: SpacedRepetitionConfig = DEFAULT_SR_CONFIG): number {
  const { intervalsDays } = config;
  if (streak <= 0) return config.lapseIntervalDays;
  return intervalsDays[Math.min(streak, intervalsDays.length) - 1];
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

/** Next schedule for a word after one quiz answer. `prev` is null for a word never quizzed. */
export function applyAnswer(
  prev: ProgressSnapshot | null,
  isCorrect: boolean,
  ctx: ScheduleContext,
  config: SpacedRepetitionConfig = DEFAULT_SR_CONFIG,
): ScheduleUpdate {
  const prevStreak = prev?.streak ?? 0;
  const prevDifficulty = prev?.difficulty ?? 0;

  let streak: number;
  let intervalDays: number;
  let status: ScheduleUpdate['status'];
  let difficulty: number;

  if (isCorrect) {
    streak = prevStreak + 1;
    intervalDays = intervalForStreak(streak, config);
    status = statusForStreak(streak, config);
    difficulty = clamp(prevDifficulty + config.difficultyOnCorrect, 0, config.maxDifficulty);
  } else {
    streak = Math.floor(prevStreak * config.lapseStreakFactor);
    intervalDays = config.lapseIntervalDays;
    status = 'learning';
    difficulty = clamp(prevDifficulty + config.difficultyOnIncorrect, 0, config.maxDifficulty);
  }

  const today = localDate(ctx.timeZone, ctx.now);
  const next = zonedMidnight(addDays(today, intervalDays), ctx.timeZone);

  return { status, streak, difficulty, intervalDays, next_review_at: next.toISOString() };
}
