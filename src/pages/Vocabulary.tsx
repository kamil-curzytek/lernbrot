import { useMemo, useState } from 'react';
import { StatusPill } from '../components/vocabulary/StatusPill';
import { useAsync } from '../hooks/useAsync';
import { displayGerman, normalizeAnswer } from '../lib/quiz';
import { listProgress } from '../services/progressService';
import { listWords } from '../services/vocabularyService';
import { CEFR_LEVELS, type CefrLevel } from '../types';

export default function Vocabulary() {
  const state = useAsync(async () => {
    const [words, progress] = await Promise.all([listWords(), listProgress()]);
    return { words, progress: new Map(progress.map((p) => [p.word_id, p])) };
  }, []);
  const [level, setLevel] = useState<CefrLevel | 'all'>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const filtered = useMemo(() => {
    if (!state.data) return [];
    const q = normalizeAnswer(query);
    return state.data.words.filter(
      (w) =>
        (level === 'all' || w.cefr_level === level) &&
        (!q || normalizeAnswer(`${displayGerman(w)} ${w.english}`).includes(q)),
    );
  }, [state.data, level, query]);

  if (state.loading) return <div className="loading">Loading vocabulary…</div>;
  if (state.error || !state.data) return <div className="alert">Could not load vocabulary: {state.error}</div>;

  return (
    <div className="stack">
      <div>
        <h1>Vocabulary</h1>
        <p className="muted">{state.data.words.length} everyday words. New ones arrive in your daily lesson.</p>
      </div>
      <div className="row">
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="Search German or English" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="row" style={{ gap: 4 }}>
          {(['all', ...CEFR_LEVELS] as const).map((l) => (
            <button key={l} className={`btn ${level === l ? 'btn-primary' : ''}`} style={{ padding: '8px 12px' }} onClick={() => setLevel(l)}>
              {l === 'all' ? 'All' : l}
            </button>
          ))}
        </div>
      </div>
      <div className="card" style={{ padding: '4px 20px' }}>
        <ul className="list">
          {filtered.map((w) => {
            const p = state.data!.progress.get(w.id);
            return (
              <li key={w.id} onClick={() => setOpen(open === w.id ? null : w.id)} style={{ cursor: 'pointer' }}>
                <div className="row">
                  <strong lang="de">{displayGerman(w)}</strong>
                  <span className="muted">{w.english}</span>
                  <span className="spacer" />
                  <span className="pill">{w.cefr_level}</span>
                  {p ? <StatusPill status={p.status} /> : <span className="pill">Not seen</span>}
                </div>
                {open === w.id && (
                  <div className="small" style={{ marginTop: 8 }}>
                    {w.plural && <div className="muted" lang="de">Plural: die {w.plural}</div>}
                    <div lang="de">{w.example_sentence}</div>
                    <div className="muted">{w.example_translation}</div>
                    {w.usage_note && <div className="muted" style={{ marginTop: 4 }}>{w.usage_note}</div>}
                  </div>
                )}
              </li>
            );
          })}
          {filtered.length === 0 && <li className="muted">No words match.</li>}
        </ul>
      </div>
    </div>
  );
}
