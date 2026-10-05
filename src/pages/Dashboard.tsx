import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../AppContext';
import { DailyTargetPicker } from '../components/dashboard/DailyTargetPicker';
import { StatTile } from '../components/dashboard/StatTile';
import { useAsync } from '../hooks/useAsync';
import { useTodaySession } from '../hooks/useTodaySession';
import { greeting } from '../lib/dailySession/stats';
import { updateDailyTarget } from '../services/profileService';
import { getDashboardStats } from '../services/progressService';
import type { DailySession } from '../types';

function localHour(timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}

/** Where the learner should go next, and what the button says. */
function nextStep(s: DailySession): { to: string; label: string } {
  const answered = Object.keys(s.quiz_draft.answers ?? {}).length;
  if (answered > 0) return { to: '/quiz', label: `Continue the quiz (${answered} of ${s.total_word_count} answered)` };
  if (s.study_position >= s.total_word_count) return { to: '/quiz', label: 'Start the quiz' };
  if (s.study_position > 0) return { to: '/lesson', label: `Continue: word ${s.study_position + 1} of ${s.total_word_count}` };
  return { to: '/lesson', label: "Start today's lesson" };
}

export default function Dashboard() {
  const { profile, setProfile } = useApp();
  const today = useTodaySession();
  const stats = useAsync(() => getDashboardStats(profile.timezone), [profile.timezone, today.data?.session.status]);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetBusy, setTargetBusy] = useState(false);
  const [targetMessage, setTargetMessage] = useState<string | null>(null);

  const s = today.data?.session;
  const untouched = s && s.status === 'ready' && s.study_position === 0 && Object.keys(s.quiz_draft.answers ?? {}).length === 0;

  async function changeTarget(n: number) {
    setTargetBusy(true);
    setTargetMessage(null);
    try {
      const { profile: updated, todayUpdated } = await updateDailyTarget(n);
      setProfile(updated);
      if (todayUpdated) today.reload();
      setTargetMessage(
        todayUpdated || s?.total_word_count === n
          ? `Today's lesson now has ${n} words.`
          : `Saved. From tomorrow you'll get ${n} words a day (today's lesson is already under way).`,
      );
      setEditingTarget(false);
    } catch (e) {
      setTargetMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setTargetBusy(false);
    }
  }

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
              {s.review_word_count} review · {s.new_word_count} new ·{' '}
              <button className="link-btn" onClick={() => setEditingTarget(!editingTarget)}>
                {editingTarget ? 'cancel' : 'change words per day'}
              </button>
            </p>

            {s.status !== 'completed' && s.review_word_count > 0 && s.new_word_count < Math.ceil(s.total_word_count * 0.2) && (
              <p className="small" style={{ marginTop: -4 }}>
                {s.new_word_count === 0
                  ? '🔁 Catch-up day: lots of words are due, so today is all review. New words return once you’re caught up.'
                  : '🔁 Busy review day: fewer new words today so nothing gets forgotten.'}
              </p>
            )}

            {editingTarget && (
              <div className="stack" style={{ marginBottom: 16 }}>
                <DailyTargetPicker value={profile.daily_word_target} onChange={changeTarget} disabled={targetBusy} />
                <p className="muted small" style={{ margin: 0 }}>
                  {untouched
                    ? "Today's lesson hasn't started, so it changes right away."
                    : "You've already started today, so the new number applies from tomorrow."}
                </p>
              </div>
            )}
            {targetMessage && <div className="notice" style={{ marginBottom: 12 }}>{targetMessage}</div>}

            {s.status === 'completed' ? (
              <div className="stack">
                <div className="notice">
                  ✓ Done for today, {s.quiz_score} / {s.total_word_count}. Your next {profile.daily_word_target} will be ready tomorrow.
                </div>
                <Link to="/quiz" className="btn">See today's results</Link>
              </div>
            ) : (
              <Link to={nextStep(s).to} className="btn btn-primary btn-lg btn-block" style={{ marginTop: 8 }}>
                {nextStep(s).label}
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
