import { db, unwrap } from '../lib/supabase/client';
import type { GrammarTopic } from '../types';

export type TopicRef = Pick<GrammarTopic, 'id' | 'slug' | 'title'>;

export async function listTopics(): Promise<GrammarTopic[]> {
  return unwrap(
    await db().from('grammar_topics').select('*').order('cefr_level').order('planned_order'),
  ) as GrammarTopic[];
}

export async function getTopic(slug: string): Promise<GrammarTopic | null> {
  return unwrap(await db().from('grammar_topics').select('*').eq('slug', slug).maybeSingle()) as GrammarTopic | null;
}

/** Grammar topics linked to each word, e.g. helfen -> Dative. */
export async function topicsForWords(wordIds: readonly number[]): Promise<Map<number, TopicRef[]>> {
  const out = new Map<number, TopicRef[]>();
  if (wordIds.length === 0) return out;
  const rows = unwrap(
    await db().from('vocabulary_grammar_links').select('word_id, topic:grammar_topics(id, slug, title)').in('word_id', wordIds as number[]),
  ) as unknown as { word_id: number; topic: TopicRef }[];
  for (const r of rows) out.set(r.word_id, [...(out.get(r.word_id) ?? []), r.topic]);
  return out;
}

export async function wordsForTopic(topicId: number): Promise<number[]> {
  const rows = unwrap(await db().from('vocabulary_grammar_links').select('word_id').eq('topic_id', topicId)) as { word_id: number }[];
  return rows.map((r) => r.word_id);
}
