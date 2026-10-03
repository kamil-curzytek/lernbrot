import { Link } from 'react-router-dom';
import { displayGerman } from '../../lib/quiz';
import type { VocabularyWord } from '../../types';

interface Props {
  score: number;
  total: number;
  words: VocabularyWord[];
  incorrectWordIds: number[];
  dailyTarget: number;
}

export function QuizResults({ score, total, words, incorrectWordIds, dailyTarget }: Props) {
  const wrong = words.filter((w) => incorrectWordIds.includes(w.id));
  const good = total - wrong.length;

  return (
    <div className="narrow stack">
      <div className="card center">
        <div className="score-big">
          {score} / {total}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>Today's progress is saved.</p>
      </div>

      <div className="card stack">
        <div>
          <strong style={{ color: 'var(--good)' }}>✓ {good} {good === 1 ? 'word' : 'words'} looking good</strong>
        </div>
        {wrong.length > 0 ? (
          <div>
            <strong>Review again soon:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {wrong.map((w) => (
                <li key={w.id}>
                  <span lang="de">{displayGerman(w)}</span> <span className="muted">· {w.english}</span>
                </li>
              ))}
            </ul>
            <p className="muted small" style={{ marginTop: 8 }}>These come back in tomorrow's session.</p>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>A perfect round. These words will come back later, spaced out.</p>
        )}
      </div>

      <p className="muted center">Come back tomorrow for your next {dailyTarget}.</p>
      <Link to="/" className="btn btn-primary btn-block">Back home</Link>
    </div>
  );
}
