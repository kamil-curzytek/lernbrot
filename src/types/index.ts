// Row types mirror supabase/migrations/*.sql.

export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2';
export const CEFR_LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2'];

export type PartOfSpeech =
  | 'noun' | 'verb' | 'adjective' | 'adverb' | 'preposition' | 'phrase' | 'pronoun' | 'conjunction';

export type Article = 'der' | 'die' | 'das';

export type ProgressStatus = 'new' | 'learning' | 'familiar' | 'strong' | 'review';

export interface Profile {
  id: string;
  current_cefr_level: CefrLevel;
  daily_word_target: number;
  timezone: string;
  onboarded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VocabularyWord {
  id: number;
  german: string;
  english: string;
  part_of_speech: PartOfSpeech;
  article: Article | null;
  plural: string | null;
  cefr_level: CefrLevel;
  frequency_rank: number;
  topic: string;
  example_sentence: string;
  example_translation: string;
  usage_note: string | null;
}

export interface VocabularyProgress {
  id: string;
  user_id: string;
  word_id: number;
  status: ProgressStatus;
  first_seen_at: string | null;
  last_seen_at: string | null;
  next_review_at: string | null;
  times_seen: number;
  times_correct: number;
  times_incorrect: number;
  streak: number;
  difficulty: number;
  created_at: string;
  updated_at: string;
}

export interface DailySession {
  id: string;
  user_id: string;
  session_date: string; // YYYY-MM-DD, learner's local date
  new_word_count: number;
  review_word_count: number;
  total_word_count: number;
  status: 'ready' | 'completed';
  quiz_score: number | null;
  created_at: string;
  completed_at: string | null;
  /** How many study cards the learner has gone through (saved after each card). */
  study_position: number;
  /** Quiz answers saved so far, keyed by question id. */
  quiz_draft: QuizDraft;
}

export interface QuizDraft {
  startedAt?: string;
  answers?: Record<string, string>;
}

/** Words-per-day choices: 5 to 50 in steps of 5. */
export const DAILY_TARGET_OPTIONS = Array.from({ length: 10 }, (_, i) => (i + 1) * 5);

export interface DailySessionWord {
  session_id: string;
  word_id: number;
  position: number;
  kind: 'new' | 'review';
}

export interface QuizAttempt {
  id: string;
  user_id: string;
  daily_session_id: string;
  quiz_date: string;
  score: number;
  total_questions: number;
  duration_seconds: number;
  created_at: string;
}

export interface QuizAnswerRow {
  id: string;
  quiz_attempt_id: string;
  word_id: number;
  question_type: string;
  user_answer: string;
  correct_answer: string;
  is_correct: boolean;
  created_at: string;
}

export interface GrammarExample {
  de: string;
  en: string;
}

export interface GrammarLessonContent {
  what: string;
  rule: string;
  examples: GrammarExample[];
  mistake: { wrong: string; right: string; why: string };
  everyday: GrammarExample[];
  remember: string;
}

export interface GrammarTopic {
  id: number;
  slug: string;
  title: string;
  cefr_level: CefrLevel;
  planned_order: number;
  summary: string;
  content: GrammarLessonContent | null; // null = outline only
}

/** A session word joined with its content and the learner's progress. */
export interface SessionItem {
  word: VocabularyWord;
  kind: 'new' | 'review';
  position: number;
  progress: VocabularyProgress | null;
  grammarTopics: Pick<GrammarTopic, 'id' | 'slug' | 'title'>[];
}
