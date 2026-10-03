import type { VocabularyWord } from '../../types';

/** "der Termin", "sich erinnern", "helfen" */
export function displayGerman(w: Pick<VocabularyWord, 'german' | 'article'>): string {
  return w.article ? `${w.article} ${w.german}` : w.german;
}

/** The form that appears inside sentences: "sich erinnern" -> "erinnern". */
export function coreForm(w: Pick<VocabularyWord, 'german'>): string {
  return w.german.replace(/^sich\s+/i, '');
}

/** Lenient comparison for typed answers: case, punctuation, ß/ss and umlaut spellings (ae/oe/ue). */
export function normalizeAnswer(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/[.,!?;:"„“”()–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Gloss overlap: two words whose English meanings overlap must never appear as
// the right answer and a distractor in the same question.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'to', 'a', 'an', 'the', 'of', 'on', 'in', 'at', 'for', 'by', 'with', 'and', 'or',
  'sb', 'sth', 'someone', 'something', 'one', 'it', 'your', 'my', 'i', 'you', 'me', 'that', 's', 'd',
]);

// Near-synonyms that share no word but could both be "right".
const SYNONYM_GROUPS: string[][] = [
  ['beautiful', 'pretty', 'nice', 'lovely', 'good', 'well', 'fine', 'great'],
  ['big', 'large', 'tall', 'great', 'high'],
  ['small', 'little', 'short'],
  ['fast', 'quick', 'quickly', 'immediately', 'soon'],
  ['buy', 'shop', 'shopping', 'purchase', 'order'],
  ['speak', 'talk', 'say', 'tell', 'explain'],
  ['see', 'look', 'watch'],
  ['want', 'like', 'would', 'wish', 'please', 'pleased', 'pleasing'],
  ['ill', 'sick', 'cold'],
  ['happy', 'glad', 'satisfied', 'content', 'pleased'],
  ['tired', 'exhausting', 'tiring'],
  ['work', 'job', 'office'],
  ['meet', 'meeting', 'appointment'],
  ['cancel', 'quit', 'resignation', 'termination', 'notice'],
  ['postpone', 'reschedule', 'move'],
  ['take', 'bring', 'pick', 'collect'],
  ['stop', 'station', 'platform'],
  ['trip', 'journey', 'travel', 'holiday', 'vacation'],
  ['town', 'city', 'area', 'surroundings', 'neighbourhood'],
  ['empty', 'free', 'available'],
  ['sorry', 'excuse', 'pardon'],
  ['bye', 'later', 'soon'],
  ['maybe', 'perhaps'],
  ['although', 'nevertheless', 'still', 'however', 'anyway'],
  ['quite', 'rather', 'pretty', 'very'],
  ['effort', 'expense', 'challenge'],
  ['effect', 'impact', 'influence'],
  ['understand', 'follow'],
  ['careful', 'cautious'],
  ['remember', 'forget'],
  ['find', 'search', 'look'],
];

const GROUPS_BY_TOKEN = new Map<string, number[]>();
SYNONYM_GROUPS.forEach((group, i) => {
  for (const t of group) GROUPS_BY_TOKEN.set(t, [...(GROUPS_BY_TOKEN.get(t) ?? []), i]);
});

/** Content words and synonym-group keys for an English gloss. */
export function glossKeys(english: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of english.toLowerCase().split(/[^a-z]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    keys.add(raw);
    for (const g of GROUPS_BY_TOKEN.get(raw) ?? []) keys.add(`#${g}`);
  }
  return keys;
}

export function glossesConflict(a: string, b: string): boolean {
  const ka = glossKeys(a);
  for (const k of glossKeys(b)) if (ka.has(k)) return true;
  return false;
}

/** "flat, apartment" -> "flat"; "to go (on foot), to walk" -> "to go (on foot)" */
export function primaryGloss(english: string): string {
  return normalizeAnswer(english.split(/[,;]/)[0]);
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface SentenceMatch {
  index: number;
  text: string; // the exact surface form in the sentence
}

/** Finds `form` as a whole word/phrase in `sentence`. Returns null unless it occurs exactly once. */
export function findInSentence(sentence: string, form: string): SentenceMatch | null {
  const re = new RegExp(`(?<![\\p{L}\\-])${escapeRegExp(form)}(?![\\p{L}\\-])`, 'giu');
  const matches = [...sentence.matchAll(re)];
  if (matches.length !== 1) return null;
  return { index: matches[0].index ?? 0, text: matches[0][0] };
}

export const BLANK = '_____';

export function blankOut(sentence: string, match: SentenceMatch): string {
  return sentence.slice(0, match.index) + BLANK + sentence.slice(match.index + match.text.length);
}
