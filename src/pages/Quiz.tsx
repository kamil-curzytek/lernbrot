import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../AppContext';
import { QuestionView } from '../components/quiz/QuestionView';
import { QuizResults } from '../components/quiz/QuizResults';
import { useAsync } from '../hooks/useAsync';
import { useTodaySession } from '../hooks/useTodaySession';
import { saveQuizAnswer } from '../services/dailySessionService';
import { buildQuizForSession, getAttemptForSession, submitQuiz } from '../services/quizService';
import type { DailySession, SessionItem } from '../types';

export default function Quiz() {
  const today = useTodaySession();
  if (today.loading) return <div className="loading">Loading…</div>;
  if (today.error || !today.data) {
    return (
      <div className="alert">
        Could not load today's session: {today.error} <button className="btn btn-ghost" onClick={today.reload}>Retry</button>
      </div>
    );
  }
  const { session, items } = today.data;
  return session.status === 'completed'
    ? <SavedResults sessionId={session.id} items={items} />
    : <RunQuiz session={session} items={items} />;
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

function RunQuiz({ session, items }: { session: DailySession; items: SessionItem[] }) {
  const sessionId = session.id;
  const { profile } = useApp();
  const quiz = useAsync(() => buildQuizForSession(sessionId, items), [sessionId]);
  // Answers saved earlier (this device or another) are restored and stay locked.
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...(session.quiz_draft.answers ?? {}) }));
  const [index, setIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [answerSaveFailed, setAnswerSaveFailed] = useState(false);
  const [result, setResult] = useState<{ score: number; total: number; incorrect: number[] } | null>(null);
  const startedAt = useRef(session.quiz_draft.startedAt ? Date.parse(session.quiz_draft.startedAt) : Date.now());

  // Continue at the first question that has no saved answer.
  useEffect(() => {
    if (quiz.data && index === null) {
      const firstOpen = quiz.data.findIndex((q) => answers[q.id] === undefined);
      setIndex(firstOpen === -1 ? quiz.data.length - 1 : firstOpen);
    }
  }, [quiz.data, index, answers]);

  if (quiz.loading || (quiz.data && index === null)) return <div className="loading">Building your quiz…</div>;
  if (quiz.error || !quiz.data || index === null) return <div className="alert">Could not build the quiz: {quiz.error}</div>;

  if (result) {
    return (
      <QuizResults
        score={result.score}
        total={result.total}
        words={items.map((i) => i.word)}
        incorrectWordIds={result.incorrect}
        dailyTarget={profile.daily_word_target}
      />
    );
  }

  const questions = quiz.data;
  const q = questions[index];
  const answered = answers[q.id] !== undefined;
  const last = index === questions.length - 1;

  async function finish() {
    setSaving(true);
    setSaveError(null);
    try {
      const { submission } = await submitQuiz({
        sessionId,
        questions,
        answers,
        items,
        timeZone: profile.timezone,
        durationSeconds: (Date.now() - startedAt.current) / 1000,
      });
      setResult({ score: submission.score, total: submission.total, incorrect: submission.incorrectWordIds });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="narrow stack">
      <div className="row">
        <Link to="/lesson" className="btn btn-ghost" style={{ paddingLeft: 0 }}>← Study cards</Link>
        <span className="spacer" />
        <span className="muted small">
          Question {index + 1} / {questions.length}
        </span>
      </div>
      <div className="progress-bar" aria-hidden>
        <div style={{ width: `${((index + (answered ? 1 : 0)) / questions.length) * 100}%` }} />
      </div>

      <QuestionView key={q.id} question={q} answer={answers[q.id]} onAnswer={(a) => {
          setAnswers((prev) => ({ ...prev, [q.id]: a }));
          saveQuizAnswer(sessionId, q.id, a).then(() => setAnswerSaveFailed(false), () => setAnswerSaveFailed(true));
        }} />

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
