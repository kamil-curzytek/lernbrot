import { Link } from 'react-router-dom';
import { useContext } from 'react';
import { AppContext } from '../AppContext';
import { DEFAULT_SR_CONFIG, typicalGaps } from '../lib/spacedRepetition';

// Mirrors the adaptive new-word rule in create_daily_session_for (migration 0005).
function lessonMix(n: number) {
  return {
    onTrack: Math.ceil(0.2 * n),
    busy: Math.ceil(0.1 * n),
  };
}

function humanDays(d: number): string {
  if (d < 14) return d === 1 ? '1 day' : `${d} days`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  if (d < 365) return `${Math.round(d / 30)} months`;
  const years = Math.round((d / 365) * 2) / 2;
  return years === 1 ? '1 year' : `${years} years`;
}

function formatGaps(days: number[]) {
  const parts = days.map(humanDays);
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const DEFAULT_DAILY_TARGET = 10;

// Public page: works signed in (uses your own daily target) and signed out (from the sign-in screen).
export default function About() {
  const app = useContext(AppContext);
  const n = app?.profile.daily_word_target ?? DEFAULT_DAILY_TARGET;
  const mix = lessonMix(n);
  const gaps = typicalGaps(7);
  const target = Math.round(DEFAULT_SR_CONFIG.requestRetention * 100);

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
          Lernbrot keeps an estimate of how well you remember each word, and brings it back when your chance of
          remembering it drops to about {target}&nbsp;%: just before you'd forget it. Every time you remember a word, the
          gap grows. For a typical word it's about {formatGaps(gaps)}.
        </p>
        <p>
          A wrong answer brings the word back <strong>tomorrow</strong>, and you can practise it again right after the
          quiz. If you come back late, after a holiday for example, and still remember a word, that counts in
          your favour: its next gap gets longer.
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          New words start with multiple choice. After that you type the answer, because remembering a word yourself
          sticks better than picking it from a list. Well-known nouns also ask for their article and plural.
        </p>
      </details>

      <details className="card">
        <summary>How grammar works</summary>
        <p>
          Every lesson, from A1 to B2, is a short explanation followed by practice. Each lesson is split into small rules,
          and you practise one rule until you get it right three times.
        </p>
        <p>
          After that, the rule comes back in your daily lesson: up to three grammar questions a day, on top of your words,
          mixed from different lessons and spaced out like your vocabulary. Mixing rules is harder in the moment but
          helps you remember them for longer.
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          When you get one wrong you see the rule behind it and a link to the lesson. <em>Progress</em> shows which
          kinds of mistakes you make most (cases, word order, verb forms …) and where to practise them.
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
