import { useState } from 'react';
import { useApp } from '../AppContext';
import { StatTile } from '../components/dashboard/StatTile';
import { useAsync } from '../hooks/useAsync';
import { browserTimeZone } from '../lib/time';
import { getDashboardStats } from '../services/progressService';
import { DailyTargetPicker } from '../components/dashboard/DailyTargetPicker';
import { ChangePassword } from '../components/progress/ChangePassword';
import { WeakSpots } from '../components/progress/WeakSpots';
import { updateDailyTarget, updateSettings } from '../services/profileService';
import { listAttempts } from '../services/quizService';
import { CEFR_LEVELS, type CefrLevel } from '../types';

const STATUS_ORDER = ['learning', 'review', 'familiar', 'strong'] as const;

export default function Progress() {
  const { user, profile, setProfile, signOut } = useApp();
  const stats = useAsync(() => getDashboardStats(profile.timezone), [profile.timezone]);
  const attempts = useAsync(() => listAttempts(14), []);

  const [level, setLevel] = useState<CefrLevel>(profile.current_cefr_level);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const deviceTz = browserTimeZone();

  async function save(patch: Parameters<typeof updateSettings>[1]) {
    setSaving(true);
    setMessage(null);
    try {
      setProfile(await updateSettings(user.id, patch));
      setMessage('Saved. Changes apply from your next daily session.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveTarget(n: number) {
    setSaving(true);
    setMessage(null);
    try {
      const { profile: updated, todayUpdated } = await updateDailyTarget(n);
      setProfile(updated);
      setMessage(todayUpdated ? `Saved. Today's lesson now has ${n} words.` : `Saved. You'll get ${n} words a day from your next lesson.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const total = stats.data ? STATUS_ORDER.reduce((n, s) => n + stats.data!.byStatus[s], 0) : 0;

  return (
    <div className="stack">
      <h1>Progress</h1>

      <section className="stats">
        <StatTile value={stats.data?.learned ?? '–'} label="Words learned" />
        <StatTile value={stats.data?.due ?? '–'} label="Due for review" />
        <StatTile value={stats.data ? `${stats.data.streak}d` : '–'} label="Current streak" />
      </section>

      {stats.data && total > 0 && (
        <section className="card">
          <h2>Your words</h2>
          <ul className="list">
            {STATUS_ORDER.map((s) => (
              <li key={s} className="row">
                <span style={{ textTransform: 'capitalize', width: 80 }}>{s}</span>
                <div className="progress-bar spacer">
                  <div style={{ width: `${(stats.data!.byStatus[s] / total) * 100}%` }} />
                </div>
                <span className="muted small" style={{ width: 32, textAlign: 'right' }}>{stats.data!.byStatus[s]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <WeakSpots />

      <section className="card">
        <h2>Recent quizzes</h2>
        {attempts.data && attempts.data.length > 0 ? (
          <ul className="list">
            {attempts.data.map((a) => (
              <li key={a.id} className="row">
                <span>{a.quiz_date}</span>
                <span className="spacer" />
                <strong>{a.score} / {a.total_questions}</strong>
                <span className="muted small">{Math.max(1, Math.round(a.duration_seconds / 60))} min</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{attempts.loading ? 'Loading…' : 'No quizzes yet.'}</p>
        )}
      </section>

      <section className="card stack">
        <h2>Settings</h2>
        <label className="field">
          <span>Level</span>
          <select className="input" value={level} onChange={(e) => setLevel(e.target.value as CefrLevel)}>
            {CEFR_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <button
          className="btn"
          disabled={saving || level === profile.current_cefr_level}
          onClick={() => save({ current_cefr_level: level })}
        >
          Save level
        </button>
        <div className="field">
          <span className="muted small" style={{ display: 'block', marginBottom: 6 }}>Words per day</span>
          <DailyTargetPicker value={profile.daily_word_target} onChange={saveTarget} disabled={saving} />
        </div>
        <div className="small muted">
          Timezone: <strong>{profile.timezone}</strong>
          {deviceTz !== profile.timezone && (
            <>
              {' '}· this device uses {deviceTz}.{' '}
              <button className="btn btn-ghost small" style={{ padding: '2px 6px' }} disabled={saving} onClick={() => save({ timezone: deviceTz })}>
                Use {deviceTz}
              </button>
            </>
          )}
        </div>
        {message && <div className="notice">{message}</div>}
      </section>

      <section className="card stack">
        <h2>Account</h2>
        <p className="muted small" style={{ margin: 0 }}>Signed in as {user.email}</p>
        {user.email && <ChangePassword email={user.email} />}
        <div>
          <button className="btn btn-ghost" style={{ paddingLeft: 0 }} onClick={signOut}>Sign out</button>
        </div>
      </section>
    </div>
  );
}
