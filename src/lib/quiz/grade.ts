import { applyAnswer, DEFAULT_SR_CONFIG, type ProgressSnapshot, type ScheduleContext, type SpacedRepetitionConfig } from '../spacedRepetition';
import type { QuestionType, QuizQuestion } from './questions';
import { normalizeAnswer } from './text';

export function isCorrect(question: QuizQuestion, answer: string): boolean {
  if (question.format === 'choice') return answer === question.correctAnswer;
  return question.accepted.includes(normalizeAnswer(answer));
}

export interface AnswerPayload {
  word_id: number;
  question_type: QuestionType;
  user_answer: string;
  correct_answer: string;
  is_correct: boolean;
}

export interface SchedulePayload {
  word_id: number;
  status: 'learning' | 'familiar' | 'strong';
  streak: number;
  difficulty: number;
  next_review_at: string;
}

export interface QuizSubmission {
  score: number;
  total: number;
  answers: AnswerPayload[];
  schedule: SchedulePayload[];
  incorrectWordIds: number[];
}

/** Grades every question and computes each word's next review. Pure and deterministic. */
export function buildSubmission(
  questions: readonly QuizQuestion[],
  userAnswers: Readonly<Record<string, string>>,
  progressByWord: ReadonlyMap<number, ProgressSnapshot>,
  ctx: ScheduleContext,
  config: SpacedRepetitionConfig = DEFAULT_SR_CONFIG,
): QuizSubmission {
  const answers: AnswerPayload[] = [];
  const schedule: SchedulePayload[] = [];
  const incorrectWordIds: number[] = [];

  for (const q of questions) {
    const given = userAnswers[q.id] ?? '';
    const ok = isCorrect(q, given);
    answers.push({
      word_id: q.wordId,
      question_type: q.type,
      user_answer: given,
      correct_answer: q.correctAnswer,
      is_correct: ok,
    });
    const next = applyAnswer(progressByWord.get(q.wordId) ?? null, ok, ctx, config);
    schedule.push({
      word_id: q.wordId,
      status: next.status,
      streak: next.streak,
      difficulty: next.difficulty,
      next_review_at: next.next_review_at,
    });
    if (!ok) incorrectWordIds.push(q.wordId);
  }

  return {
    score: answers.filter((a) => a.is_correct).length,
    total: answers.length,
    answers,
    schedule,
    incorrectWordIds,
  };
}
