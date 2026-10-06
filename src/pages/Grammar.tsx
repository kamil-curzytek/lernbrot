import { Link } from 'react-router-dom';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { loadGrammarSkills } from '../lib/grammar';
import { getGrammarProgress } from '../services/grammarPracticeService';
import { listTopics } from '../services/grammarService';
import { CEFR_LEVELS } from '../types';

export default function Grammar() {
  const { profile } = useApp();
  const topics = useAsync(listTopics, []);
  // rules per topic and how many of them the learner has practised (failure here only hides the counts)
  const practice = useAsync(async () => {
    const [skills, progress] = await Promise.all([loadGrammarSkills(), getGrammarProgress()]);
    const perTopic = new Map<string, { total: number; studied: number }>();
    for (const sk of skills.values()) {
      const e = perTopic.get(sk.topic) ?? { total: 0, studied: 0 };
      e.total++;
      if (progress.has(sk.id)) e.studied++;
      perTopic.set(sk.topic, e);
    }
    return perTopic;
  }, []);

  if (topics.loading) return <div className="loading">Loading grammar…</div>;
  if (topics.error || !topics.data) return <div className="alert">Could not load grammar: {topics.error}</div>;

  return (
    <div className="stack">
      <div>
        <h1>Grammar</h1>
        <p className="muted">
          Short, practical lessons with practice. Rules you practise come back in your daily lessons, a few at a time.
        </p>
      </div>
      {CEFR_LEVELS.map((level) => {
        const list = topics.data!.filter((t) => t.cefr_level === level);
        if (list.length === 0) return null;
        return (
          <section key={level} className="card">
            <div className="row" style={{ marginBottom: 6 }}>
              <h2 style={{ margin: 0 }}>{level}</h2>
              {level === profile.current_cefr_level && <span className="pill pill-new">Your level</span>}
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
                  {practice.data?.get(t.slug) && (
                    <div className="small" style={{ marginTop: 2 }}>
                      {practice.data.get(t.slug)!.studied > 0
                        ? `✓ ${practice.data.get(t.slug)!.studied} / ${practice.data.get(t.slug)!.total} rules practised`
                        : <span className="muted">{practice.data.get(t.slug)!.total} {practice.data.get(t.slug)!.total === 1 ? 'rule' : 'rules'} to practise</span>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
