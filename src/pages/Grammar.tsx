import { Link } from 'react-router-dom';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { listTopics } from '../services/grammarService';
import { CEFR_LEVELS } from '../types';

export default function Grammar() {
  const { profile } = useApp();
  const topics = useAsync(listTopics, []);

  if (topics.loading) return <div className="loading">Loading grammar…</div>;
  if (topics.error || !topics.data) return <div className="alert">Could not load grammar: {topics.error}</div>;

  return (
    <div className="stack">
      <div>
        <h1>Grammar</h1>
        <p className="muted">Short, practical lessons. Your daily words link here when a rule matters.</p>
      </div>
      {CEFR_LEVELS.map((level) => {
        const list = topics.data!.filter((t) => t.cefr_level === level);
        if (list.length === 0) return null;
        const outline = list.every((t) => !t.content);
        return (
          <section key={level} className="card">
            <div className="row" style={{ marginBottom: 6 }}>
              <h2 style={{ margin: 0 }}>{level}</h2>
              {level === profile.current_cefr_level && <span className="pill pill-new">Your level</span>}
              {outline && <span className="pill">Outline · lessons coming later</span>}
            </div>
            <ul className="list">
              {list.map((t) => (
                <li key={t.id}>
                  {t.content ? (
                    <Link to={`/grammar/${t.slug}`} style={{ fontWeight: 600, textDecoration: 'none' }}>{t.title}</Link>
                  ) : (
                    <span style={{ fontWeight: 600 }}>{t.title}</span>
                  )}
                  <div className="muted small">{t.summary}</div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
