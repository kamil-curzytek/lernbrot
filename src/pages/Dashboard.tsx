import { Link } from 'react-router-dom';
import { useApp } from '../AppContext';
import { StatTile } from '../components/dashboard/StatTile';
import { useAsync } from '../hooks/useAsync';
import { useTodaySession } from '../hooks/useTodaySession';
import { greeting } from '../lib/dailySession/stats';
import { getDashboardStats } from '../services/progressService';

function localHour(timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}

export default function Dashboard() {
  const { profile } = useApp();
  const today = useTodaySession();
  const stats = useAsync(() => getDashboardStats(profile.timezone), [profile.timezone, today.data?.session.status]);

  const s = today.data?.session;

  return (
    <div className="stack">
      <section className="card hero">
        <h1>{greeting(localHour(profile.timezone))}</h1>
        <p className="muted" style={{ marginBottom: 0 }}>Your German today:</p>

        {today.loading && <div className="loading">Preparing today's words…</div>}
        {today.error && (
          <div className="alert" style={{ marginTop: 12 }}>
            Could not load today's lesson: {today.error}{' '}
            <button className="btn btn-ghost" onClick={today.reload}>Retry</button>
          </div>
        )}

        {s && (
          <>
            <div className="big">{s.total_word_count} words</div>
            <p className="muted">
              {s.review_word_count} review · {s.new_word_count} new
            </p>
            {s.status === 'completed' ? (
              <div className="stack">
                <div className="notice">
                  ✓ Done for today, {s.quiz_score} / {s.total_word_count}. Your next {profile.daily_word_target} will be ready tomorrow.
                </div>
                <Link to="/quiz" className="btn">See today's results</Link>
              </div>
            ) : (
              <Link to="/lesson" className="btn btn-primary btn-lg btn-block" style={{ marginTop: 8 }}>
                Start today's lesson
              </Link>
            )}
          </>
        )}
      </section>

      <section className="stats" aria-label="Your progress">
        <StatTile value={stats.data?.learned ?? '–'} label="Words learned" />
        <StatTile value={stats.data?.due ?? '–'} label="Due for review" />
        <StatTile value={stats.data ? `${stats.data.streak} ${stats.data.streak === 1 ? 'day' : 'days'}` : '–'} label="Current streak" />
      </section>

      <p className="muted small center">
        Want some context? <Link to="/grammar">Browse short grammar lessons</Link>
      </p>
    </div>
  );
}
