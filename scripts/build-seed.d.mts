export interface SeedContent {
  words: Array<Record<string, any> & { id: number; grammar: string[] }>;
  topics: Array<Record<string, any> & { id: number; slug: string }>;
  links: Array<{ word_id: number; topic_id: number }>;
  skills: Array<Record<string, any> & { id: number; topic_id: number; item_count: number }>;
}
export function loadContent(): SeedContent;
export function buildSql(content: SeedContent): string;
