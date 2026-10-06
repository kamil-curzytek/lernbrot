// Question builders. Each returns null when it cannot produce a question with
// exactly one defensible answer; the generator then tries another type.

import { CEFR_LEVELS, type Article, type VocabularyWord } from '../../types';
import { shuffle, type Rng } from './random';
import {
  blankOut,
  coreForm,
  displayGerman,
  findInSentence,
  glossesConflict,
  normalizeAnswer,
  primaryGloss,
} from './text';

export type QuestionType =
  | 'de_en'        // L1: German -> English, multiple choice
  | 'en_de'        // L2: English -> German, multiple choice
  | 'context'      // L2: which word fits the sentence? multiple choice
  | 'fill_blank'   // L3: type the missing word in the sentence
  | 'en_de_typed'  // L3: type the German for an English word
  | 'article'      // L4: der / die / das
  | 'plural';      // L4: type the plural

export type QuestionLevel = 1 | 2 | 3 | 4;

export const QUESTION_LEVEL: Record<QuestionType, QuestionLevel> = {
  de_en: 1,
  en_de: 2,
  context: 2,
  fill_blank: 3,
  en_de_typed: 3,
  article: 4,
  plural: 4,
};

export const QUESTION_TYPES = Object.keys(QUESTION_LEVEL) as QuestionType[];

export interface QuizQuestion {
  id: string;
  wordId: number;
  type: QuestionType;
  level: QuestionLevel;
  format: 'choice' | 'typed';
  instruction: string;
  prompt: string;
  helper?: string;
  options?: string[];
  /** Normalized accepted answers (typed) or the exact correct option (choice). */
  accepted: string[];
  correctAnswer: string;
  /** Extra feedback after a wrong answer, e.g. a reliable gender rule. */
  hint?: string;
}

const OPTION_COUNT = 4;

function pickDistractors(
  word: VocabularyWord,
  pool: readonly VocabularyWord[],
  rng: Rng,
  extraFilter: (d: VocabularyWord) => boolean,
  label: (d: VocabularyWord) => string,
): string[] | null {
  const correctLabel = normalizeAnswer(label(word));
  const seen = new Set([correctLabel]);
  const out: string[] = [];
  const candidates = pool.filter(
    (d) =>
      d.id !== word.id &&
      d.part_of_speech === word.part_of_speech &&
      !glossesConflict(d.english, word.english) &&
      extraFilter(d),
  );
  // Prefer distractors from the word's own level, so beginners aren't shown B2 words.
  const levelGap = (d: VocabularyWord) => Math.abs(CEFR_LEVELS.indexOf(d.cefr_level) - CEFR_LEVELS.indexOf(word.cefr_level));
  const ordered = shuffle(candidates, rng).sort((a, b) => levelGap(a) - levelGap(b));
  for (const d of ordered) {
    const l = label(d);
    const key = normalizeAnswer(l);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length === OPTION_COUNT - 1) return out;
  }
  return null;
}

function choice(
  word: VocabularyWord,
  type: QuestionType,
  instruction: string,
  prompt: string,
  correct: string,
  distractors: string[],
  rng: Rng,
  helper?: string,
): QuizQuestion {
  return {
    id: `${word.id}:${type}`,
    wordId: word.id,
    type,
    level: QUESTION_LEVEL[type],
    format: 'choice',
    instruction,
    prompt,
    helper,
    options: shuffle([correct, ...distractors], rng),
    accepted: [correct],
    correctAnswer: correct,
  };
}

function typed(
  word: VocabularyWord,
  type: QuestionType,
  instruction: string,
  prompt: string,
  correct: string,
  accepted: string[],
  helper?: string,
): QuizQuestion {
  return {
    id: `${word.id}:${type}`,
    wordId: word.id,
    type,
    level: QUESTION_LEVEL[type],
    format: 'typed',
    instruction,
    prompt,
    helper,
    accepted: [...new Set(accepted.map(normalizeAnswer))],
    correctAnswer: correct,
  };
}

export function buildDeEn(word: VocabularyWord, pool: readonly VocabularyWord[], rng: Rng): QuizQuestion | null {
  const d = pickDistractors(word, pool, rng, () => true, (x) => x.english);
  if (!d) return null;
  return choice(word, 'de_en', 'What does this mean?', displayGerman(word), word.english, d, rng);
}

export function buildEnDe(word: VocabularyWord, pool: readonly VocabularyWord[], rng: Rng): QuizQuestion | null {
  const d = pickDistractors(
    word, pool, rng,
    (x) => normalizeAnswer(coreForm(x)) !== normalizeAnswer(coreForm(word)),
    displayGerman,
  );
  if (!d) return null;
  return choice(word, 'en_de', 'How do you say this in German?', word.english, displayGerman(word), d, rng);
}

function sentenceBlank(word: VocabularyWord) {
  const match = findInSentence(word.example_sentence, coreForm(word));
  return match ? { match, blanked: blankOut(word.example_sentence, match) } : null;
}

export function buildContext(word: VocabularyWord, pool: readonly VocabularyWord[], rng: Rng): QuizQuestion | null {
  const s = sentenceBlank(word);
  if (!s) return null;
  // Distractors come from other topics and must not already appear in the sentence;
  // the translation is shown, so only one option matches the meaning.
  const d = pickDistractors(
    word, pool, rng,
    (x) =>
      x.topic !== word.topic &&
      findInSentence(word.example_sentence, coreForm(x)) === null &&
      normalizeAnswer(coreForm(x)) !== normalizeAnswer(s.match.text),
    coreForm,
  );
  if (!d) return null;
  return choice(word, 'context', 'Which word fits the sentence?', s.blanked, s.match.text, d, rng, word.example_translation);
}

export function buildFillBlank(word: VocabularyWord): QuizQuestion | null {
  const s = sentenceBlank(word);
  if (!s) return null;
  const answer = s.match.text;
  const hint = `${word.example_translation}  ·  starts with “${answer[0]}”, ${answer.replace(/\s/g, '').length} letters`;
  return typed(word, 'fill_blank', 'Type the missing word.', s.blanked, answer, [answer], hint);
}

export function buildEnDeTyped(word: VocabularyWord, pool: readonly VocabularyWord[]): QuizQuestion | null {
  // Typed recall is only fair when no other word shares the same main meaning.
  const gloss = primaryGloss(word.english);
  if (pool.some((x) => x.id !== word.id && primaryGloss(x.english) === gloss)) return null;
  const core = coreForm(word);
  const accepted = [core, word.german, displayGerman(word)];
  const helper = word.part_of_speech === 'noun' ? 'Noun: adding der/die/das is optional, but it must be right.' : undefined;
  return typed(word, 'en_de_typed', 'Type the German word.', word.english, displayGerman(word), accepted, helper);
}

// Endings that predict the article almost without exception (99–100 % on the curriculum's 2,194 nouns;
// research/grammar-strategy). Less reliable rules (-e, -er, -um, -nis) are deliberately not shown.
const GENDER_RULES: [RegExp, string, Article][] = [
  [/ung$/, '-ung', 'die'], [/heit$/, '-heit', 'die'], [/keit$/, '-keit', 'die'], [/schaft$/, '-schaft', 'die'],
  [/tät$/, '-tät', 'die'], [/ion$/, '-ion', 'die'], [/ismus$/, '-ismus', 'der'],
];

/** "Words ending in -ung are always die." when a reliable rule fits the noun (and agrees with it). */
export function genderHint(word: Pick<VocabularyWord, 'german' | 'article'>): string | undefined {
  const head = word.german.toLowerCase().split(/[\s-]/).pop() ?? '';
  for (const [rx, ending, article] of GENDER_RULES) {
    if (rx.test(head) && word.article === article) return `Tip: nouns ending in ${ending} are ${article}.`;
  }
  return undefined;
}

export function buildArticle(word: VocabularyWord): QuizQuestion | null {
  if (word.part_of_speech !== 'noun' || !word.article) return null;
  return {
    id: `${word.id}:article`,
    wordId: word.id,
    type: 'article',
    level: QUESTION_LEVEL.article,
    format: 'choice',
    instruction: 'Choose the article.',
    prompt: `___ ${word.german}`,
    helper: word.english,
    options: ['der', 'die', 'das'],
    accepted: [word.article],
    correctAnswer: word.article,
    hint: genderHint(word),
  };
}

export function buildPlural(word: VocabularyWord): QuizQuestion | null {
  if (word.part_of_speech !== 'noun' || !word.article || !word.plural) return null;
  return typed(
    word, 'plural', 'Type the plural.', `${displayGerman(word)} → die …`,
    `die ${word.plural}`, [word.plural, `die ${word.plural}`], word.english,
  );
}

export function buildQuestion(
  type: QuestionType,
  word: VocabularyWord,
  pool: readonly VocabularyWord[],
  rng: Rng,
): QuizQuestion | null {
  switch (type) {
    case 'de_en': return buildDeEn(word, pool, rng);
    case 'en_de': return buildEnDe(word, pool, rng);
    case 'context': return buildContext(word, pool, rng);
    case 'fill_blank': return buildFillBlank(word);
    case 'en_de_typed': return buildEnDeTyped(word, pool);
    case 'article': return buildArticle(word);
    case 'plural': return buildPlural(word);
  }
}
