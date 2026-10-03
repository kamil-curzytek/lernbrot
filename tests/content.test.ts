// Quality gates for the seed content and for every question the engine can generate from it.
import { describe, expect, it } from 'vitest';
import { loadContent } from '../scripts/build-seed.mjs';
import { buildQuestion, QUESTION_TYPES, type QuizQuestion } from '../src/lib/quiz';
import { createRng } from '../src/lib/quiz/random';
import { coreForm, findInSentence, glossesConflict, normalizeAnswer, primaryGloss } from '../src/lib/quiz/text';
import type { VocabularyWord } from '../src/types';

const { words, topics } = loadContent() as unknown as { words: (VocabularyWord & { grammar: string[] })[]; topics: any[] };

describe('vocabulary seed', () => {
  it('has a small curated set with the planned level spread', () => {
    const by = (l: string) => words.filter((w) => w.cefr_level === l).length;
    expect(words.length).toBeGreaterThanOrEqual(150);
    expect(words.length).toBeLessThanOrEqual(270);
    expect(by('A1')).toBeGreaterThanOrEqual(100);
    expect(by('A2')).toBeGreaterThanOrEqual(60);
    expect(by('B1')).toBeGreaterThanOrEqual(20);
    expect(by('B2')).toBeGreaterThanOrEqual(10);
  });

  it('has unique ids and unique German entries', () => {
    expect(new Set(words.map((w) => w.id)).size).toBe(words.length);
    expect(new Set(words.map((w) => `${w.german}|${w.part_of_speech}`)).size).toBe(words.length);
  });

  it('gives every noun an article, and only nouns', () => {
    for (const w of words) {
      if (w.part_of_speech === 'noun') expect(w.article, w.german).toMatch(/^(der|die|das)$/);
      else expect(w.article, w.german).toBeNull();
      if (w.part_of_speech === 'noun') expect(w.german[0], w.german).toBe(w.german[0].toUpperCase());
    }
  });

  it('gives every word a complete example with translation', () => {
    for (const w of words) {
      expect(w.example_sentence.length, w.german).toBeGreaterThan(5);
      expect(w.example_translation.length, w.german).toBeGreaterThan(3);
      expect(w.example_sentence, w.german).toMatch(/[.!?]$/);
    }
  });

  it('covers the required everyday topics and parts of speech', () => {
    const t = new Set(words.map((w) => w.topic));
    for (const topic of ['home', 'work', 'food', 'shopping', 'transport', 'appointments', 'communication', 'people', 'time', 'everyday', 'travel']) {
      expect(t.has(topic), topic).toBe(true);
    }
    const pos = new Set<string>(words.map((w) => w.part_of_speech));
    for (const p of ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'phrase']) expect(pos.has(p), p).toBe(true);
  });

  it('has no two words with the same main English meaning', () => {
    const seen = new Map<string, string>();
    for (const w of words) {
      const g = primaryGloss(w.english);
      expect(seen.get(g), `${w.german} vs ${seen.get(g)}: "${g}"`).toBeUndefined();
      seen.set(g, w.german);
    }
  });

  it('most words can be blanked in their own example sentence', () => {
    const ok = words.filter((w) => findInSentence(w.example_sentence, coreForm(w)));
    expect(ok.length / words.length).toBeGreaterThan(0.75);
  });
});

describe('grammar seed', () => {
  it('has 15-20 A1 lessons, 10-15 A2 lessons, and B1/B2 as outline only', () => {
    const lv = (l: string) => topics.filter((t) => t.cefr_level === l);
    expect(lv('A1').length).toBeGreaterThanOrEqual(15);
    expect(lv('A1').length).toBeLessThanOrEqual(20);
    expect(lv('A2').length).toBeGreaterThanOrEqual(10);
    expect(lv('A2').length).toBeLessThanOrEqual(15);
    for (const t of [...lv('A1'), ...lv('A2')]) {
      for (const k of ['what', 'rule', 'examples', 'mistake', 'everyday', 'remember']) expect(t.content?.[k], `${t.slug}.${k}`).toBeTruthy();
    }
    for (const t of [...lv('B1'), ...lv('B2')]) expect(t.content).toBeNull();
  });

  it('links vocabulary to grammar (e.g. helfen -> Dative)', () => {
    const helfen = words.find((w) => w.german === 'helfen')!;
    expect(helfen.grammar).toContain('dative');
  });
});

describe('every generated question is unambiguous', () => {
  const all: QuizQuestion[] = [];
  for (const w of words) {
    for (const type of QUESTION_TYPES) {
      for (const seed of ['a', 'b', 'c']) {
        const q = buildQuestion(type, w, words, createRng(`${w.id}${type}${seed}`));
        if (q) all.push(q);
      }
    }
  }
  const byId = new Map(words.map((w) => [w.id, w]));

  it('generates many questions of every type', () => {
    for (const t of QUESTION_TYPES) expect(all.filter((q) => q.type === t).length, t).toBeGreaterThan(20);
  });

  it('choice questions: correct answer present once, distinct options, no overlapping meaning', () => {
    for (const q of all.filter((x) => x.format === 'choice')) {
      const opts = q.options!;
      expect(opts.filter((o) => o === q.correctAnswer).length, q.id).toBe(1);
      expect(new Set(opts.map(normalizeAnswer)).size, q.id).toBe(opts.length);
      if (q.type === 'article') continue;
      const target = byId.get(q.wordId)!;
      const others = opts.filter((o) => o !== q.correctAnswer);
      for (const o of others) {
        const w = q.type === 'de_en'
          ? words.find((x) => x.english === o)
          : words.find((x) => (x.article ? `${x.article} ${x.german}` : x.german) === o || coreForm(x) === o);
        expect(w, `${q.id}: option ${o}`).toBeDefined();
        expect(glossesConflict(w!.english, target.english), `${q.id}: ${o} overlaps ${target.english}`).toBe(false);
      }
    }
  });

  it('sentence questions blank exactly one occurrence and no option already appears in the sentence', () => {
    for (const q of all.filter((x) => x.type === 'context' || x.type === 'fill_blank')) {
      expect(q.prompt.split('_____').length, q.id).toBe(2);
      expect(q.helper, q.id).toBeTruthy(); // translation shown -> one meaning fits
      for (const o of q.options ?? []) {
        if (o === q.correctAnswer) continue;
        expect(findInSentence(q.prompt, o), `${q.id}: ${o}`).toBeNull();
      }
    }
  });

  it('typed questions accept their own correct answer', () => {
    for (const q of all.filter((x) => x.format === 'typed')) {
      expect(q.accepted, q.id).toContain(normalizeAnswer(q.correctAnswer));
    }
  });
});
