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
 * 1 new or just missed (recognition, multiple choice) · 3 one to three in a row (typed recall)
 * · 4 four or more in a row (typed recall, plus article/plural).
 * From the second success on a word must be recalled, not recognised: recognising it among options is
 * weaker evidence (and can be a guess), so only recall moves it on at full speed (see spacedRepetition).
 */
export function wordLevel(progress: QuizItem['progress']): QuestionLevel {
  if (!progress || progress.times_seen === 0 || progress.streak <= 0) return 1;
  if (progress.streak <= 3) return 3;
  return 4;
}

const isTyped = (t: QuestionType) => t !== 'de_en' && t !== 'en_de' && t !== 'context' && t !== 'article';

/** Types allowed for a word. Level 1: multiple choice only. Level 3+: typed recall (article joins at level 4). */
export function allowedTypes(level: QuestionLevel): QuestionType[] {
  if (level <= 2) return QUESTION_TYPES.filter((t) => QUESTION_LEVEL[t] <= 2);
  return QUESTION_TYPES.filter((t) => QUESTION_LEVEL[t] >= 3 && QUESTION_LEVEL[t] <= level && (level === 4 || isTyped(t)));
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
  // No clean question of the right kind (e.g. an ambiguous gloss): stay with recall if possible.
  if (candidates.length === 0 && level >= 3) candidates = build(QUESTION_TYPES.filter(isTyped));
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
