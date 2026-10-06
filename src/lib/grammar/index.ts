// Grammar exercises: built from content/grammar-skills.json (compiled from content/grammar/*.txt by
// scripts/build-grammar.mjs). Pure functions; seeded shuffling so a session looks the same everywhere.
// Why skills, mixing and rule feedback: research/grammar-strategy/grammar-strategy.md.

import type { GrammarCategory } from '../../types';
import { normalizeAnswer } from '../quiz/text';
import { createRng, hashString, shuffle } from '../quiz/random';
import { applyAnswer, type ProgressSnapshot, type ScheduleContext, type ScheduleUpdate } from '../spacedRepetition';

export interface GrammarItem {
  id: string; // "<skillId>:<n>"
  type: 'c' | 't' | 'o' | 'm';
  prompt: string;
  en: string;
  options?: string[];
  answer: string;
  accepted?: string[];
  chunks?: string[];
  alternatives?: string[];
  punct?: '.' | '?';
  explain?: string;
}

export interface GrammarSkill {
  id: number;
  topic: string; // topic slug
  topicId: number;
  cefr: 'A1' | 'A2' | 'B1' | 'B2';
  category: GrammarCategory;
  title: string;
  rule: string;
  ask?: string;
  requires: number[];
  items: GrammarItem[];
}

export interface GrammarExercise {
  /** Answer key in the session draft: "g<skillId>:<n>". */
  id: string;
  skillId: number;
  itemId: string;
  topic: string;
  format: 'choice' | 'typed' | 'order';
  instruction: string;
  prompt: string;
  helper: string;
  options?: string[];
  /** Order exercises: chunks in display (shuffled) order. */
  chunks?: string[];
  punct?: '.' | '?';
  correctAnswer: string;
  accepted: string[];
  /** Shown after a wrong answer: the item's own note, else the skill's rule. */
  explanation: string;
  category: GrammarCategory;
}

let cache: Promise<Map<number, GrammarSkill>> | null = null;

/** Loads the compiled skills once (code-split: only fetched when grammar practice is used). */
export function loadGrammarSkills(): Promise<Map<number, GrammarSkill>> {
  cache ??= import('../../../content/grammar-skills.json').then(
    (m) => new Map((m.default.skills as unknown as GrammarSkill[]).map((s) => [s.id, s])),
  );
  return cache;
}

const DEFAULT_INSTRUCTION: Record<GrammarItem['type'], string> = {
  c: 'Choose the right form.',
  t: 'Type the missing word.',
  o: 'Put the words in the right order.',
  m: 'Read the sentence and answer.',
};

function sentence(chunks: readonly string[], punct: string): string {
  const s = chunks.join(' ').replace(/\s+,/g, ',');
  return s.charAt(0).toUpperCase() + s.slice(1) + punct;
}

/** Builds the exercise for one item. `seed` only affects the order of options/chunks. */
export function buildExercise(skill: GrammarSkill, item: GrammarItem, seed: string): GrammarExercise {
  const rng = createRng(`${seed}:${item.id}`);
  const n = item.id.split(':')[1];
  const base = {
    id: `g${skill.id}:${n}`,
    skillId: skill.id,
    itemId: item.id,
    topic: skill.topic,
    instruction: skill.ask ?? DEFAULT_INSTRUCTION[item.type],
    helper: item.en,
    explanation: item.explain ?? skill.rule,
    category: skill.category,
  };
  if (item.type === 'o') {
    const chunks = item.chunks!;
    let shown = shuffle(chunks, rng);
    // never show the answer already in order
    for (let i = 0; i < 5 && shown.every((c, k) => c === chunks[k]); i++) shown = shuffle(chunks, rng);
    if (shown.every((c, k) => c === chunks[k])) shown = [...chunks.slice(1), chunks[0]];
    const punct = item.punct ?? '.';
    return {
      ...base,
      format: 'order',
      prompt: '',
      chunks: shown,
      punct,
      correctAnswer: sentence(chunks, punct),
      accepted: [item.answer, ...(item.alternatives ?? [])].map(normalizeAnswer),
    };
  }
  if (item.type === 't') {
    return { ...base, format: 'typed', prompt: item.prompt, correctAnswer: item.answer, accepted: item.accepted ?? [normalizeAnswer(item.answer)] };
  }
  return {
    ...base,
    format: 'choice',
    prompt: item.prompt,
    options: shuffle(item.options!, rng),
    correctAnswer: item.answer,
    accepted: [item.answer],
  };
}

/** Order answers are the chosen chunks joined by spaces; typed answers are normalised. */
export function isGrammarCorrect(ex: GrammarExercise, answer: string): boolean {
  if (ex.format === 'choice') return answer === ex.correctAnswer;
  return ex.accepted.includes(normalizeAnswer(answer));
}

/** The prompt with the right answer filled in, for feedback. */
export function solvedSentence(ex: GrammarExercise): string {
  if (ex.format === 'order') return ex.correctAnswer;
  return ex.prompt.includes('___') ? ex.prompt.replace('___', ex.correctAnswer).replace(/\s*\([^)]*\)\s*$/, '') : ex.prompt;
}

/** Which exercise of a skill to use in a daily session: rotates with the number of reviews so far. */
export function pickItem(skill: GrammarSkill, seed: string, reviewsSoFar: number): GrammarItem {
  const start = hashString(`${seed}:${skill.id}`) % skill.items.length;
  return skill.items[(start + reviewsSoFar) % skill.items.length];
}

/** Lesson practice: the skill's exercises in a seeded order (blocked practice of one rule). */
export function practiceQueue(skill: GrammarSkill, seed: string): GrammarItem[] {
  return shuffle(skill.items, createRng(`practice:${seed}:${skill.id}`));
}

/** Correct answers needed before a skill counts as studied (initial criterion, successive relearning). */
export const PRACTICE_CRITERION = 3;

/** Typed recall and sentence building count as recall; choosing an option counts as recognition. */
export function scheduleGrammar(prev: ProgressSnapshot | null, ex: GrammarExercise, correct: boolean, ctx: ScheduleContext): ScheduleUpdate {
  return applyAnswer(prev, { correct, format: ex.format === 'choice' ? 'choice' : 'typed' }, ctx);
}

export const CATEGORY_LABEL: Record<GrammarCategory, string> = {
  case: 'Cases (der/den/dem)',
  gender: 'Gender (der, die, das)',
  verb_form: 'Verb forms',
  word_order: 'Word order',
  adjective_ending: 'Adjective endings',
  preposition: 'Prepositions',
  pronoun: 'Pronouns',
  negation: 'Negation',
  tense: 'Past tenses',
  mood: 'Konjunktiv & polite forms',
  other: 'Connectors & other',
};
