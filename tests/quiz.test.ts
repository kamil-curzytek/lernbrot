import { describe, expect, it } from 'vitest';
import { loadContent } from '../scripts/build-seed.mjs';
import {
  buildArticle,
  buildEnDeTyped,
  buildFillBlank,
  buildPlural,
  buildSubmission,
  generateQuiz,
  isCorrect,
  wordLevel,
  type QuizItem,
} from '../src/lib/quiz';
import type { VocabularyWord } from '../src/types';

const words = loadContent().words as unknown as VocabularyWord[];
const byGerman = (g: string) => words.find((w) => w.german === g)!;
const now = new Date('2026-10-01T18:00:00Z');

const firstDay: QuizItem[] = words.filter((w) => w.cefr_level === 'A1').slice(0, 10).map((word) => ({ word, progress: null }));

describe('quiz generation', () => {
  it('asks exactly one question per session word and only about session words', () => {
    const quiz = generateQuiz(firstDay, words, 'session-1');
    expect(quiz).toHaveLength(10);
    expect(new Set(quiz.map((q) => q.wordId))).toEqual(new Set(firstDay.map((i) => i.word.id)));
  });

  it('mixes question types even on day one', () => {
    const quiz = generateQuiz(firstDay, words, 'session-1');
    const types = new Set(quiz.map((q) => q.type));
    expect(types.size).toBeGreaterThanOrEqual(3);
    const max = Math.max(...[...types].map((t) => quiz.filter((q) => q.type === t).length));
    expect(max).toBeLessThanOrEqual(5);
  });

  it('uses easy questions for new words and harder retrieval for well-known words', () => {
    const fresh = generateQuiz(firstDay, words, 's');
    expect(Math.max(...fresh.map((q) => q.level))).toBeLessThanOrEqual(2);

    const known: QuizItem[] = firstDay.map((i) => ({ ...i, progress: { streak: 5, times_seen: 5 } }));
    const hard = generateQuiz(known, words, 's');
    expect(Math.min(...hard.map((q) => q.level))).toBeGreaterThanOrEqual(3);
  });

  it('orders questions from easier to harder', () => {
    const mixed: QuizItem[] = firstDay.map((i, n) => ({ ...i, progress: { streak: n % 5, times_seen: n } }));
    const levels = generateQuiz(mixed, words, 'x').map((q) => q.level);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it('draws distractors from the same CEFR level as the word', () => {
    const levelOf = new Map(words.flatMap((w) => [[w.english, w.cefr_level], [w.german, w.cefr_level], [`${w.article} ${w.german}`, w.cefr_level]]));
    for (const q of generateQuiz(firstDay, words, 'lvl')) {
      for (const o of q.options ?? []) if (levelOf.has(o) && q.type !== 'article') expect(levelOf.get(o), `${q.id}: ${o}`).toBe('A1');
    }
  });

  it('is deterministic for a given session', () => {
    expect(generateQuiz(firstDay, words, 'abc')).toEqual(generateQuiz(firstDay, words, 'abc'));
  });

  it('maps progress to levels', () => {
    expect(wordLevel(null)).toBe(1);
    expect(wordLevel({ streak: 0, times_seen: 3 })).toBe(1);
    expect(wordLevel({ streak: 1, times_seen: 1 })).toBe(2);
    expect(wordLevel({ streak: 3, times_seen: 3 })).toBe(3);
    expect(wordLevel({ streak: 7, times_seen: 7 })).toBe(4);
  });
});

describe('grading', () => {
  const termin = byGerman('Termin');

  it('accepts typed answers leniently but not wrong articles', () => {
    const q = buildEnDeTyped(termin, words)!;
    expect(isCorrect(q, 'Termin')).toBe(true);
    expect(isCorrect(q, '  termin ')).toBe(true);
    expect(isCorrect(q, 'der Termin')).toBe(true);
    expect(isCorrect(q, 'die Termin')).toBe(false);
    expect(isCorrect(q, 'Termine')).toBe(false);
  });

  it('fill in the blank: expects the word as it appears in the sentence', () => {
    const q = buildFillBlank(termin)!;
    expect(q.prompt).toBe('Ich habe morgen einen _____ beim Arzt.');
    expect(isCorrect(q, 'Termin')).toBe(true);
    expect(isCorrect(q, 'Arzt')).toBe(false);
  });

  it('accepts ae/oe/ue/ss spellings', () => {
    expect(isCorrect(buildPlural(byGerman('Schlüssel'))!, 'Schluessel')).toBe(true);
    expect(isCorrect(buildPlural(byGerman('Straße'))!, 'die Strassen')).toBe(true);
    expect(isCorrect(buildEnDeTyped(byGerman('müde'), words)!, 'muede')).toBe(true);
  });

  it('article questions: der / die / das with one right answer', () => {
    const q = buildArticle(termin)!;
    expect(q.prompt).toBe('___ Termin');
    expect(isCorrect(q, 'der')).toBe(true);
    expect(isCorrect(q, 'die')).toBe(false);
    expect(buildArticle(byGerman('helfen'))).toBeNull();
  });

  it('8/10: stores every answer and computes a schedule for every word', () => {
    const quiz = generateQuiz(firstDay, words, 'session-1');
    const answers: Record<string, string> = {};
    quiz.forEach((q, i) => {
      answers[q.id] = i < 8 ? q.correctAnswer : 'wrong';
    });
    const sub = buildSubmission(quiz, answers, new Map(), { now, timeZone: 'Europe/Berlin' });
    expect(sub.score).toBe(8);
    expect(sub.total).toBe(10);
    expect(sub.answers).toHaveLength(10);
    expect(sub.answers.filter((a) => !a.is_correct)).toHaveLength(2);
    expect(sub.incorrectWordIds).toEqual(quiz.slice(8).map((q) => q.wordId));
    expect(sub.schedule).toHaveLength(10);
    // everything comes back tomorrow after the first quiz (1 day for correct, 1 day lapse)
    expect(new Set(sub.schedule.map((s) => s.next_review_at))).toEqual(new Set(['2026-10-01T22:00:00.000Z']));
    const wrong = sub.schedule.filter((s) => sub.incorrectWordIds.includes(s.word_id));
    expect(wrong.every((s) => s.status === 'learning' && s.streak === 0)).toBe(true);
  });
});
