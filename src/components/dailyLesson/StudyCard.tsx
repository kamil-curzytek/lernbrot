import { Link } from 'react-router-dom';
import type { SessionItem } from '../../types';
import { GermanWord } from '../vocabulary/StatusPill';

/** One word. The German is shown first; the learner reveals the rest. */
export function StudyCard({ item, revealed, onReveal }: { item: SessionItem; revealed: boolean; onReveal: () => void }) {
  const w = item.word;
  return (
    <div className="card study-card">
      <div className="row" style={{ justifyContent: 'center' }}>
        <span className={`pill ${item.kind === 'new' ? 'pill-new' : 'pill-review'}`}>{item.kind === 'new' ? 'New word' : 'Review'}</span>
        <span className="pill">{w.cefr_level}</span>
      </div>

      <div className="study-word" lang="de">
        <GermanWord german={w.german} article={w.article} />
      </div>

      {revealed ? (
        <div>
          <div className="study-meaning">{w.english}</div>
          {w.plural && (
            <div className="study-plural" lang="de">
              Plural: die {w.plural}
            </div>
          )}
          <div className="study-example">
            <p className="de" lang="de" style={{ margin: 0 }}>{w.example_sentence}</p>
            <p className="en">{w.example_translation}</p>
          </div>
          {w.usage_note && <p className="study-note">{w.usage_note}</p>}
          {item.grammarTopics.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <span className="muted small">Grammar: </span>
              {item.grammarTopics.map((t) => (
                <Link key={t.id} to={`/grammar/${t.slug}`} className="chip-link">
                  {t.title}
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button className="btn reveal-btn" onClick={onReveal} autoFocus>
          Show meaning <span className="muted small">(space)</span>
        </button>
      )}
    </div>
  );
}
