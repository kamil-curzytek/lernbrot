import { buildExercise, loadGrammarSkills, pickItem, scheduleGrammar, type GrammarExercise } from '../lib/grammar';
import { db, unwrap } from '../lib/supabase/client';
import type { GrammarAnswerRow, GrammarCategory, GrammarProgress, GrammarSkillRow } from '../types';

export async function listGrammarSkills(): Promise<GrammarSkillRow[]> {
  return unwrap(await db().from('grammar_skills').select('*').order('sort_order')) as GrammarSkillRow[];
}

/** The learner's progress per skill (only studied skills have a row). */
export async function getGrammarProgress(): Promise<Map<number, GrammarProgress>> {
  const rows = unwrap(await db().from('grammar_progress').select('*')) as GrammarProgress[];
  return new Map(rows.map((r) => [r.skill_id, r]));
}

/** After practising on the lesson page: the skills join the daily reviews from tomorrow. */
export async function recordGrammarStudy(skillIds: number[]): Promise<number> {
  return unwrap(await db().rpc('record_grammar_study', { p_skill_ids: skillIds })) as number;
}

export interface SessionGrammarItem {
  exercise: GrammarExercise;
  progress: GrammarProgress | null;
}

/** Today's grammar exercises (0–3), deterministic per session so every device shows the same. */
export async function getSessionGrammar(sessionId: string): Promise<SessionGrammarItem[]> {
  const rows = unwrap(
    await db().from('daily_session_grammar').select('skill_id, position').eq('session_id', sessionId).order('position'),
  ) as { skill_id: number; position: number }[];
  if (rows.length === 0) return [];
  const [skills, progress] = await Promise.all([loadGrammarSkills(), getGrammarProgress()]);
  return rows.flatMap((r) => {
    const skill = skills.get(r.skill_id);
    if (!skill) return [];
    const p = progress.get(r.skill_id) ?? null;
    const item = pickItem(skill, sessionId, p ? p.times_correct + p.times_incorrect : 0);
    return [{ exercise: buildExercise(skill, item, sessionId), progress: p }];
  });
}

/** Grades locally, computes each skill's next review with FSRS, stores everything in one call. */
export async function submitGrammarReview(params: {
  sessionId: string;
  items: readonly SessionGrammarItem[];
  answers: Readonly<Record<string, string>>;
  isCorrect: (ex: GrammarExercise, answer: string) => boolean;
  timeZone: string;
}): Promise<{ score: number; total: number; wrongSkillIds: number[] }> {
  const now = new Date();
  const entries = params.items.map(({ exercise: ex, progress: p }) => {
    const given = params.answers[ex.id] ?? '';
    const ok = params.isCorrect(ex, given);
    const next = scheduleGrammar(p ? { ...p, difficulty: 0 } : null, ex, ok, { now, timeZone: params.timeZone });
    return {
      skill_id: ex.skillId,
      item_id: ex.itemId,
      user_answer: given,
      correct_answer: ex.correctAnswer,
      is_correct: ok,
      error_category: ex.category,
      status: next.status,
      streak: next.streak,
      stability: next.stability,
      fsrs_difficulty: next.fsrs_difficulty,
      next_review_at: next.next_review_at,
    };
  });
  const score = unwrap(await db().rpc('submit_grammar_review', { p_session_id: params.sessionId, p_entries: entries })) as number;
  return { score, total: entries.length, wrongSkillIds: entries.filter((e) => !e.is_correct).map((e) => e.skill_id) };
}

export interface WeakSpot {
  category: GrammarCategory;
  answers: number;
  wrong: number;
  errorRate: number;
  /** Skill with the most wrong answers in this category (to suggest its lesson). */
  worstSkillId: number | null;
}

/**
 * Error rate per grammar category over the last `days` days: grammar answers plus the article
 * questions of the vocabulary quiz (gender). Only categories with enough answers are returned.
 */
export async function getWeakSpots(days = 30, minAnswers = 3): Promise<WeakSpot[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [grammar, articles] = await Promise.all([
    db().from('grammar_answers').select('id, skill_id, item_id, is_correct, error_category, created_at').gte('created_at', since),
    db().from('quiz_answers').select('is_correct, created_at').eq('question_type', 'article').gte('created_at', since),
  ]);
  const g = unwrap(grammar) as GrammarAnswerRow[];
  const a = unwrap(articles) as { is_correct: boolean }[];
  const by = new Map<GrammarCategory, { answers: number; wrong: number; perSkill: Map<number, number> }>();
  const bump = (cat: GrammarCategory, correct: boolean, skillId: number | null) => {
    const e = by.get(cat) ?? { answers: 0, wrong: 0, perSkill: new Map() };
    e.answers++;
    if (!correct) {
      e.wrong++;
      if (skillId !== null) e.perSkill.set(skillId, (e.perSkill.get(skillId) ?? 0) + 1);
    }
    by.set(cat, e);
  };
  for (const r of g) bump(r.error_category, r.is_correct, r.skill_id);
  for (const r of a) bump('gender', r.is_correct, null);
  return [...by.entries()]
    .filter(([, e]) => e.answers >= minAnswers && e.wrong > 0)
    .map(([category, e]) => ({
      category,
      answers: e.answers,
      wrong: e.wrong,
      errorRate: e.wrong / e.answers,
      worstSkillId: [...e.perSkill.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
    }))
    .sort((x, y) => y.errorRate - x.errorRate || y.wrong - x.wrong);
}
