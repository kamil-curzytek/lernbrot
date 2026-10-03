import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { StudyCard } from '../components/dailyLesson/StudyCard';
import { useTodaySession } from '../hooks/useTodaySession';

export default function DailyLesson() {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useTodaySession();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const items = data?.items ?? [];
  const last = index === items.length - 1;

  function next() {
    if (!revealed) return setRevealed(true);
    if (last) return navigate('/quiz');
    setIndex((i) => i + 1);
    setRevealed(false);
  }

  function back() {
    if (index === 0) return;
    setIndex((i) => i - 1);
    setRevealed(true);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        next();
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

  return (
    <div className="narrow stack">
      <div className="row">
        <Link to="/" className="btn btn-ghost" style={{ paddingLeft: 0 }}>← Home</Link>
        <span className="spacer" />
        <span className="muted small">
          {index + 1} / {items.length}
        </span>
      </div>
      <div className="progress-bar" aria-hidden>
        <div style={{ width: `${((index + (revealed ? 1 : 0.5)) / items.length) * 100}%` }} />
      </div>

      <StudyCard key={items[index].word.id} item={items[index]} revealed={revealed} onReveal={() => setRevealed(true)} />

      {revealed && (
        <div className="row">
          <button className="btn" onClick={back} disabled={index === 0}>Back</button>
          <button className="btn btn-primary spacer" onClick={next}>
            {last ? 'Start the quiz' : 'Next'}
          </button>
        </div>
      )}
      <p className="muted small center">Take a moment with each word, then try the quiz. It's only about today's words.</p>
    </div>
  );
}
