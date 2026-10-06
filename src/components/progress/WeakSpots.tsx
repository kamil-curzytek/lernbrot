import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks/useAsync';
import { CATEGORY_LABEL, loadGrammarSkills } from '../../lib/grammar';
import { getGrammarProgress, getWeakSpots } from '../../services/grammarPracticeService';

/** The learner's weakest grammar areas (last 30 days), each with the lesson to revisit. */
export function WeakSpots() {
  const data = useAsync(async () => {
    const [spots, skills, progress] = await Promise.all([getWeakSpots(), loadGrammarSkills(), getGrammarProgress()]);
    return { spots: spots.slice(0, 3), skills, studied: progress.size };
  }, []);

  return (
    <section className="card">
      <h2>Grammar</h2>
      {data.loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
      {data.error && <p className="muted" style={{ margin: 0 }}>Couldn't load: {data.error}</p>}
      {data.data && (
        <>
          <p className="muted small">
            {data.data.studied === 0
              ? 'No rules practised yet. Open a lesson in Grammar and press "Practise": the rule then comes back in your daily lessons.'
              : `${data.data.studied} ${data.data.studied === 1 ? 'rule' : 'rules'} in your daily reviews.`}
          </p>
          {data.data.spots.length > 0 ? (
            <>
              <h3 style={{ marginBottom: 6 }}>Weak spots (last 30 days)</h3>
              <ul className="skill-list">
                {data.data.spots.map((s) => {
                  const skill = s.worstSkillId !== null ? data.data!.skills.get(s.worstSkillId) : undefined;
                  return (
                    <li key={s.category}>
                      <span style={{ minWidth: 150, fontWeight: 600 }}>{CATEGORY_LABEL[s.category]}</span>
                      <div className="weak-bar" aria-hidden>
                        <div style={{ width: `${Math.round(s.errorRate * 100)}%` }} />
                      </div>
                      <span className="muted small">{s.wrong} of {s.answers} wrong</span>
                      {skill ? (
                        <Link to={`/grammar/${skill.topic}`} className="small">Practise: {skill.title} →</Link>
                      ) : s.category === 'gender' ? (
                        <Link to="/grammar/articles" className="small">Lesson: der, die, das →</Link>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            data.data.studied > 0 && <p className="muted small" style={{ margin: 0 }}>No weak spots so far. Keep going!</p>
          )}
        </>
      )}
    </section>
  );
}
