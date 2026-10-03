export interface SpacedRepetitionConfig {
  /** Days until the next review after the 1st, 2nd, 3rd… consecutive correct answer. */
  intervalsDays: number[];
  /** Days until the next review after an incorrect answer. 1 = tomorrow. */
  lapseIntervalDays: number;
  /** On an incorrect answer the streak is multiplied by this and floored (0 = full reset). */
  lapseStreakFactor: number;
  /** Streak at which a word counts as familiar / strong. */
  familiarAtStreak: number;
  strongAtStreak: number;
  /** Difficulty (0..maxDifficulty) moves by these amounts; used to rank reviews. */
  difficultyOnCorrect: number;
  difficultyOnIncorrect: number;
  maxDifficulty: number;
}

export const DEFAULT_SR_CONFIG: SpacedRepetitionConfig = {
  intervalsDays: [1, 2, 4, 7, 14, 30, 60],
  lapseIntervalDays: 1,
  lapseStreakFactor: 0.5,
  familiarAtStreak: 2,
  strongAtStreak: 4,
  difficultyOnCorrect: -1,
  difficultyOnIncorrect: 2,
  maxDifficulty: 10,
};
