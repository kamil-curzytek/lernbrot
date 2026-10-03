import { db, unwrap } from '../lib/supabase/client';
import type { VocabularyWord } from '../types';

let cache: Promise<VocabularyWord[]> | null = null;

/** All shared vocabulary (a few hundred rows), cached for the page lifetime. */
export function listWords(): Promise<VocabularyWord[]> {
  cache ??= (async () =>
    unwrap(await db().from('vocabulary_words').select('*').order('cefr_level').order('frequency_rank')) as VocabularyWord[])();
  cache.catch(() => (cache = null));
  return cache;
}

export async function getWordsByIds(ids: readonly number[]): Promise<Map<number, VocabularyWord>> {
  const all = await listWords();
  const wanted = new Set(ids);
  return new Map(all.filter((w) => wanted.has(w.id)).map((w) => [w.id, w]));
}
