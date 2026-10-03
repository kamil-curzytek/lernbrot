// Builds the day's quiz: one question per session word, difficulty chosen from
// that word's progress, question types spread out for variety, easiest first.

import type { VocabularyProgress, VocabularyWord } from '../../types';
import { createRng, type Rng } from './random';
import {
  QUESTION_LEVEL,
  QUESTION_TYPES,
  buildQuestion,
  type QuestionLevel,
  type QuestionType,
  type QuizQuestion,
} from './questions';

export interface QuizItem {
  word: VocabularyWord;
  progress: Pick<VocabularyProgress, 'streak' | 'times_seen'> | null;
}

/**
 * Retrieval level a word is ready for:
 * 1 new or just missed · 2 one correct · 3 two-three in a row · 4 four or more in a row.
 */
export function wordLevel(progress: QuizItem['progress']): QuestionLevel {
  if (!progress || progress.times_seen === 0 || progress.streak <= 0) return 1;
  if (progress.streak === 1) return 2;
  if (progress.streak <= 3) return 3;
  return 4;
}

/** Types allowed for a word: its level, one easier and one harder. */
export function allowedTypes(level: QuestionLevel): QuestionType[] {
  return QUESTION_TYPES.filter((t) => Math.abs(QUESTION_LEVEL[t] - level) <= 1);
}

function pickQuestion(
  item: QuizItem,
  pool: readonly VocabularyWord[],
  counts: Map<QuestionType, number>,
  rng: Rng,
): QuizQuestion {
  const level = wordLevel(item.progress);
  const build = (types: QuestionType[]) =>
    types
      .map((t) => buildQuestion(t, item.word, pool, rng))
      .filter((q): q is QuizQuestion => q !== null);

  let candidates = build(allowedTypes(level));
  if (candidates.length === 0) candidates = build(QUESTION_TYPES);
  if (candidates.length === 0) {
    throw new Error(`no valid question for word ${item.word.id} (${item.word.german})`);
  }

  // Prefer the least-used type, then the type closest to the word's level.
  const scored = candidates.map((q) => ({
    q,
    score: (counts.get(q.type) ?? 0) * 10 + Math.abs(q.level - level) * 3 + rng(),
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0].q;
}

export function generateQuiz(items: readonly QuizItem[], pool: readonly VocabularyWord[], seed: string): QuizQuestion[] {
  const rng = createRng(seed);
  const counts = new Map<QuestionType, number>();
  const questions = items.map((item, order) => {
    const q = pickQuestion(item, pool, counts, rng);
    counts.set(q.type, (counts.get(q.type) ?? 0) + 1);
    return { q, order };
  });
  // Recognition first, recall later.
  questions.sort((a, b) => a.q.level - b.q.level || a.order - b.order);
  return questions.map((x) => x.q);
}
