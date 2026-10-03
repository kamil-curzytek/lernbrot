import { Link } from 'react-router-dom';
import { useApp } from '../AppContext';
import { StatusPill } from '../components/vocabulary/StatusPill';
import { useAsync } from '../hooks/useAsync';
import { displayGerman } from '../lib/quiz';
import { addDays, daysBetween, localDate } from '../lib/time';
import { listProgress } from '../services/progressService';
import { getWordsByIds } from '../services/vocabularyService';
import type { VocabularyProgress, VocabularyWord } from '../types';

interface Row {
  p: VocabularyProgress;
  w: VocabularyWord;
}

function WordList({ rows, right }: { rows: Row[]; right: (r: Row) => string }) {
  if (rows.length === 0) return <p className="muted" style={{ margin: 0 }}>Nothing here.</p>;
  return (
    <ul className="list">
      {rows.map((r) => (
        <li key={r.w.id} className="row">
          <strong lang="de">{displayGerman(r.w)}</strong>
          <span className="muted">{r.w.english}</span>
          <span className="spacer" />
          <span className="muted small">{right(r)}</span>
          <StatusPill status={r.p.status} />
        </li>
      ))}
    </ul>
  );
}

export default function Review() {
  const { profile } = useApp();
  const tz = profile.timezone;
  const state = useAsync(async () => {
    const progress = await listProgress();
    const words = await getWordsByIds(progress.map((p) => p.word_id));
    return progress.filter((p) => words.has(p.word_id)).map((p) => ({ p, w: words.get(p.word_id)! }));
  }, []);

  if (state.loading) return <div className="loading">Loading reviews…</div>;
  if (state.error || !state.data) return <div className="alert">Could not load reviews: {state.error}</div>;

  const today = localDate(tz);
  const dueDay = (r: Row) => (r.p.next_review_at ? localDate(tz, new Date(r.p.next_review_at)) : today);
  const byDue = [...state.data].sort((a, b) => (a.p.next_review_at ?? '').localeCompare(b.p.next_review_at ?? ''));
  const dueToday = byDue.filter((r) => dueDay(r) <= today);
  const upcoming = byDue.filter((r) => dueDay(r) > today && dueDay(r) <= addDays(today, 7));
  const tricky = state.data
    .filter((r) => r.p.times_incorrect > 0)
    .sort((a, b) => b.p.times_incorrect - b.p.times_correct - (a.p.times_incorrect - a.p.times_correct))
    .slice(0, 15);

  const when = (r: Row) => {
    const d = daysBetween(today, dueDay(r));
    return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
  };

  return (
    <div className="stack">
      <div>
        <h1>Review</h1>
        <p className="muted">
          Reviews are added to <Link to="/">Today's {profile.daily_word_target}</Link> automatically, so you don't have to manage this list.
        </p>
      </div>
      <section className="card">
        <h2>Due now ({dueToday.length})</h2>
        <WordList rows={dueToday} right={when} />
      </section>
      <section className="card">
        <h2>Coming up this week ({upcoming.length})</h2>
        <WordList rows={upcoming} right={when} />
      </section>
      <section className="card">
        <h2>Tricky words</h2>
        <WordList rows={tricky} right={(r) => `${r.p.times_correct}✓ ${r.p.times_incorrect}✗`} />
      </section>
    </div>
  );
}
