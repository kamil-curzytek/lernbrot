import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { StudyCard } from '../components/dailyLesson/StudyCard';
import { useTodaySession } from '../hooks/useTodaySession';
import { saveStudyPosition } from '../services/dailySessionService';

export default function DailyLesson() {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useTodaySession();
  const [index, setIndex] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const items = data?.items ?? [];
  const session = data?.session;

  // Resume at the card the learner reached last time (on any device).
  useEffect(() => {
    if (session && items.length > 0 && index === null) {
      setIndex(Math.min(session.study_position, items.length - 1));
    }
  }, [session, items.length, index]);

  const current = index ?? 0;
  const last = current === items.length - 1;

  function persist(position: number) {
    if (!session) return Promise.resolve();
    return saveStudyPosition(session.id, position).then(
      () => setSaveFailed(false),
      () => setSaveFailed(true),
    );
  }

  async function next() {
    if (!revealed) return setRevealed(true);
    if (last) {
      await persist(items.length);
      return navigate('/quiz');
    }
    setIndex(current + 1);
    setRevealed(false);
    void persist(current + 1);
  }

  function back() {
    if (current === 0) return;
    setIndex(current - 1);
    setRevealed(true);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        void next();
      } else if (e.key === 'ArrowLeft') {
        back();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (loading) return <div className="loading">Preparing today's words…</div>;
  if (error || !data) {
    return (
      <div className="alert">
        Could not load today's lesson: {error} <button className="btn btn-ghost" onClick={reload}>Retry</button>
      </div>
    );
  }
  if (data.session.status === 'completed') return <Navigate to="/quiz" replace />;
  if (items.length === 0) return <div className="notice">There are no words to study today.</div>;
  if (index === null) return <div className="loading">Loading…</div>;

  return (
    <div className="narrow stack">
      <div className="row">
        <Link to="/" className="btn btn-ghost" style={{ paddingLeft: 0 }}>← Home</Link>
        <span className="spacer" />
        <span className="muted small">
          {current + 1} / {items.length}
        </span>
      </div>
      <div className="progress-bar" aria-hidden>
        <div style={{ width: `${((current + (revealed ? 1 : 0.5)) / items.length) * 100}%` }} />
      </div>

      <StudyCard key={items[current].word.id} item={items[current]} revealed={revealed} onReveal={() => setRevealed(true)} />

      {revealed && (
        <div className="row">
          <button className="btn" onClick={back} disabled={current === 0}>Back</button>
          <button className="btn btn-primary spacer" onClick={() => void next()}>
            {last ? 'Start the quiz' : 'Next'}
          </button>
        </div>
      )}
      {saveFailed && <p className="small center" style={{ color: 'var(--bad)' }}>Couldn't save your place. Check your connection.</p>}
      <p className="muted small center">Your place is saved after every card, so you can leave and come back any time.</p>
    </div>
  );
}
