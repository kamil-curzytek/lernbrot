export interface SpacedRepetitionConfig {
  /** Recall probability at which a word is due again (FSRS "requested retention"). 0.9 = review when ~10 % would be forgotten. */
  requestRetention: number;
  /** Longest gap between two reviews, in days. */
  maximumIntervalDays: number;
  /** Days until the next review after an incorrect answer. 1 = tomorrow. */
  lapseIntervalDays: number;
  /** On an incorrect answer the streak is multiplied by this and floored (0 = full reset). */
  lapseStreakFactor: number;
  /** Streak at which a word counts as familiar / strong (shown in the UI, drives question difficulty). */
  familiarAtStreak: number;
  strongAtStreak: number;
  /** Legacy 0..maxDifficulty counter, kept for the "often wrong" signals in the UI. */
  difficultyOnCorrect: number;
  difficultyOnIncorrect: number;
  maxDifficulty: number;
}

export const DEFAULT_SR_CONFIG: SpacedRepetitionConfig = {
  requestRetention: 0.9,
  maximumIntervalDays: 1825,
  lapseIntervalDays: 1,
  lapseStreakFactor: 0.5,
  familiarAtStreak: 2,
  strongAtStreak: 4,
  difficultyOnCorrect: -1,
  difficultyOnIncorrect: 2,
  maxDifficulty: 10,
};
