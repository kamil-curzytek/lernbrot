import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../AppContext';
import { GrammarExerciseView } from '../components/grammar/GrammarExerciseView';
import { MissedPractice } from '../components/quiz/MissedPractice';
import { QuestionView } from '../components/quiz/QuestionView';
import { QuizResults, type GrammarResult } from '../components/quiz/QuizResults';
import { useAsync } from '../hooks/useAsync';
import { useTodaySession } from '../hooks/useTodaySession';
import { isGrammarCorrect, type GrammarExercise } from '../lib/grammar';
import type { QuizQuestion } from '../lib/quiz';
import { saveQuizAnswer } from '../services/dailySessionService';
import { getSessionGrammar, submitGrammarReview, type SessionGrammarItem } from '../services/grammarPracticeService';
import { buildQuizForSession, getAttemptForSession, submitQuiz } from '../services/quizService';
import type { DailySession, SessionItem } from '../types';

type Step = { kind: 'word'; q: QuizQuestion } | { kind: 'grammar'; ex: GrammarExercise };

export default function Quiz() {
  const today = useTodaySession();
  const grammar = useAsync(async () => (today.data ? getSessionGrammar(today.data.session.id) : []), [today.data?.session.id]);
  if (today.loading || grammar.loading) return <div className="loading">Loading…</div>;
  if (today.error || !today.data) {
    return (
      <div className="alert">
        Could not load today's session: {today.error} <button className="btn btn-ghost" onClick={today.reload}>Retry</button>
      </div>
    );
  }
  const { session, items } = today.data;
  const grammarItems = grammar.data ?? [];
  const grammarPending = grammarItems.length > 0 && !session.grammar_completed_at;
  return session.status === 'completed' && !grammarPending
    ? <SavedResults sessionId={session.id} items={items} />
    : <RunQuiz session={session} items={items} grammar={grammarItems} />;
}

function SavedResults({ sessionId, items }: { sessionId: string; items: SessionItem[] }) {
  const { profile } = useApp();
  const saved = useAsync(() => getAttemptForSession(sessionId), [sessionId]);
  if (saved.loading) return <div className="loading">Loading results…</div>;
  if (!saved.data) return <div className="alert">{saved.error ?? 'No results found for today.'}</div>;
  return (
    <QuizResults
      score={saved.data.attempt.score}
      total={saved.data.attempt.total_questions}
      words={items.map((i) => i.word)}
      incorrectWordIds={saved.data.answers.filter((a) => !a.is_correct).map((a) => a.word_id)}
      dailyTarget={profile.daily_word_target}
    />
  );
}

function RunQuiz({ session, items, grammar }: { session: DailySession; items: SessionItem[]; grammar: SessionGrammarItem[] }) {
  const sessionId = session.id;
  const { profile } = useApp();
  const vocabDone = session.status === 'completed'; // only the grammar part is left (a previous save failed)
  const quiz = useAsync(() => (vocabDone ? Promise.resolve([]) : buildQuizForSession(sessionId, items)), [sessionId]);
  // Answers saved earlier (this device or another) are restored and stay locked.
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...(session.quiz_draft.answers ?? {}) }));
  const [index, setIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [answerSaveFailed, setAnswerSaveFailed] = useState(false);
  const [result, setResult] = useState<{ score: number; total: number; incorrect: number[] } | null>(null);
  const [grammarResult, setGrammarResult] = useState<GrammarResult | null>(null);
  // grammar steps are fixed when the quiz opens; the ref only guards against submitting twice
  const [grammarDoneAtStart] = useState(Boolean(session.grammar_completed_at));
  const grammarSubmitted = useRef(grammarDoneAtStart);
  const [practising, setPractising] = useState(false);
  const startedAt = useRef(session.quiz_draft.startedAt ? Date.parse(session.quiz_draft.startedAt) : Date.now());

  const steps: Step[] | null = quiz.data
    ? [...quiz.data.map((q): Step => ({ kind: 'word', q })), ...(grammarDoneAtStart ? [] : grammar.map((g): Step => ({ kind: 'grammar', ex: g.exercise })))]
    : null;
  const stepId = (s: Step) => (s.kind === 'word' ? s.q.id : s.ex.id);

  // Continue at the first question that has no saved answer.
  useEffect(() => {
    if (steps && index === null) {
      const firstOpen = steps.findIndex((s) => answers[stepId(s)] === undefined);
      setIndex(firstOpen === -1 ? Math.max(0, steps.length - 1) : firstOpen);
    }
  }, [steps, index, answers]);

  if (quiz.loading || (steps && index === null)) return <div className="loading">Building your quiz…</div>;
  if (quiz.error || !steps || index === null) return <div className="alert">Could not build the quiz: {quiz.error}</div>;

  if (result && practising) {
    const missed = (quiz.data ?? []).filter((x) => result.incorrect.includes(x.wordId));
    return <MissedPractice missed={missed} onDone={() => setPractising(false)} />;
  }

  if (result) {
    return (
      <QuizResults
        score={result.score}
        total={result.total}
        words={items.map((i) => i.word)}
        incorrectWordIds={result.incorrect}
        dailyTarget={profile.daily_word_target}
        grammar={grammarResult}
      />
    );
  }

  if (steps.length === 0) return <div className="notice">Nothing left to answer today. <Link to="/">Back home</Link></div>;

  const step = steps[index];
  const id = stepId(step);
  const answered = answers[id] !== undefined;
  const last = index === steps.length - 1;
  const grammarStart = quiz.data!.length;

  async function finish() {
    setSaving(true);
    setSaveError(null);
    try {
      if (grammar.length > 0 && !grammarSubmitted.current) {
        const g = await submitGrammarReview({ sessionId, items: grammar, answers, isCorrect: isGrammarCorrect, timeZone: profile.timezone });
        grammarSubmitted.current = true;
        setGrammarResult({ score: g.score, total: g.total, wrong: grammar.filter((x) => g.wrongSkillIds.includes(x.exercise.skillId)).map((x) => x.exercise) });
      }
      if (!vocabDone) {
        const { submission } = await submitQuiz({
          sessionId,
          questions: quiz.data!,
          answers,
          items,
          timeZone: profile.timezone,
          durationSeconds: (Date.now() - startedAt.current) / 1000,
        });
        setResult({ score: submission.score, total: submission.total, incorrect: submission.incorrectWordIds });
        setPractising(submission.incorrectWordIds.length > 0);
      } else {
        const saved = await getAttemptForSession(sessionId);
        setResult({
          score: saved?.attempt.score ?? 0,
          total: saved?.attempt.total_questions ?? 0,
          incorrect: saved?.answers.filter((a) => !a.is_correct).map((a) => a.word_id) ?? [],
        });
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const onAnswer = (a: string) => {
    setAnswers((prev) => ({ ...prev, [id]: a }));
    saveQuizAnswer(sessionId, id, a).then(() => setAnswerSaveFailed(false), () => setAnswerSaveFailed(true));
  };

  return (
    <div className="narrow stack">
      <div className="row">
        <Link to="/lesson" className="btn btn-ghost" style={{ paddingLeft: 0 }}>← Study cards</Link>
        <span className="spacer" />
        <span className="muted small">
          {step.kind === 'grammar' ? `Grammar ${index - grammarStart + 1} / ${steps.length - grammarStart}` : `Question ${index + 1} / ${grammarStart}`}
        </span>
      </div>
      <div className="progress-bar" aria-hidden>
        <div style={{ width: `${((index + (answered ? 1 : 0)) / steps.length) * 100}%` }} />
      </div>

      {step.kind === 'grammar' && index === grammarStart && !answered && (
        <p className="muted small center" style={{ margin: 0 }}>A few grammar rules you've practised, mixed up.</p>
      )}

      {step.kind === 'word' ? (
        <QuestionView key={id} question={step.q} answer={answers[id]} onAnswer={onAnswer} />
      ) : (
        <GrammarExerciseView key={id} exercise={step.ex} answer={answers[id]} onAnswer={onAnswer} linkToLesson />
      )}

      {answerSaveFailed && !saveError && (
        <p className="small center" style={{ color: 'var(--bad)' }}>Couldn't save this answer yet. It will be saved when you finish.</p>
      )}

      {saveError && (
        <div className="alert">
          Your answers are not saved yet: {saveError}. Check your connection and try again.
        </div>
      )}

      {answered && (
        last ? (
          <button className="btn btn-primary btn-lg btn-block" onClick={finish} disabled={saving} autoFocus>
            {saving ? 'Saving…' : saveError ? 'Try saving again' : 'See my results'}
          </button>
        ) : (
          <button className="btn btn-primary btn-lg btn-block" onClick={() => setIndex(index + 1)} autoFocus>
            Next question
          </button>
        )
      )}
    </div>
  );
}
