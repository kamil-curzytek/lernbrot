import { Link } from 'react-router-dom';
import { useContext } from 'react';
import { AppContext } from '../AppContext';
import { DEFAULT_SR_CONFIG } from '../lib/spacedRepetition/config';

// Mirrors the adaptive new-word rule in create_daily_session_for (migration 0005).
function lessonMix(n: number) {
  return {
    onTrack: Math.ceil(0.2 * n),
    busy: Math.ceil(0.1 * n),
  };
}

function formatIntervals(days: number[]) {
  const parts = days.map((d) => (d === 1 ? '1 day' : `${d} days`));
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const DEFAULT_DAILY_TARGET = 10;

// Public page: works signed in (uses your own daily target) and signed out (from the sign-in screen).
export default function About() {
  const app = useContext(AppContext);
  const n = app?.profile.daily_word_target ?? DEFAULT_DAILY_TARGET;
  const mix = lessonMix(n);
  const cfg = DEFAULT_SR_CONFIG;

  return (
    <div className="stack narrow about">
      <section>
        <h1>About Lernbrot</h1>
        <p className="muted">
          Practical German for everyday life in Germany, from your first words (A1) to confident conversation (B2).
          A small daily portion, like your daily bread.
        </p>
      </section>

      <details className="card" open>
        <summary>How a daily lesson works</summary>
        <p>
          Each day you get <strong>{n} words</strong>{app ? '' : ' (you can choose 5–50)'}: first the words that are due for review, then new ones. You go
          through the cards, then take a short quiz.
        </p>
        <p>The mix adapts to how many reviews are waiting, so the pile never grows out of control:</p>
        <ul>
          <li>
            <strong>On track:</strong> at least {mix.onTrack} new {mix.onTrack === 1 ? 'word' : 'words'}, the rest reviews.
          </li>
          <li>
            <strong>Busy:</strong> at least {mix.busy} new {mix.busy === 1 ? 'word' : 'words'}.
          </li>
          <li>
            <strong>Catch-up day</strong> (twice as many reviews waiting as your daily target): reviews only.
          </li>
        </ul>
        <p>
          Your next lesson is prepared in the cloud early each morning, so it's ready even if your computer was off.
          Your place is saved after every card and answer, so you can stop and continue later on any device.
          {app && (
            <>
              {' '}
              You can change your words per day (5–50) on the home screen or in <Link to="/progress">Progress</Link>.
            </>
          )}
        </p>
      </details>

      <details className="card">
        <summary>How reviews are spaced</summary>
        <p>
          Every correct answer in a row makes the gap to the next review longer: {formatIntervals(cfg.intervalsDays)}.
          That way you see a word again around the time you'd start to forget it.
        </p>
        <p>
          A wrong answer brings the word back <strong>tomorrow</strong>. You don't start from zero, though: a word you
          knew well recovers faster than a brand-new one. Words you often get wrong are shown first.
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          The quiz also gets harder as you learn a word: from recognising it, to choosing it, to typing it, and finally
          its article and plural.
        </p>
      </details>

      <details className="card">
        <summary>Your data and privacy</summary>
        <p>
          You sign in with your email and a password. Your password is never stored in readable form; only a secure
          hash is kept, so nobody, including us, can see it.
        </p>
        <p style={{ margin: 0 }}>
          Your progress belongs to your account. Other learners can't see it, and the app can only read and change your
          own data. The app's maintainer has access to the database for running the service, but never to your
          password.
        </p>
      </details>

      {!app && (
        <p className="center">
          <Link to="/" className="btn btn-primary">
            Back to sign in
          </Link>
        </p>
      )}
    </div>
  );
}
