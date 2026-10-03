import { Link, useParams } from 'react-router-dom';
import { useAsync } from '../hooks/useAsync';
import { displayGerman } from '../lib/quiz';
import { getTopic, wordsForTopic } from '../services/grammarService';
import { getWordsByIds } from '../services/vocabularyService';
import type { GrammarExample } from '../types';

function Examples({ items }: { items: GrammarExample[] }) {
  return (
    <div>
      {items.map((e) => (
        <div key={e.de} className="example">
          <div className="de" lang="de">{e.de}</div>
          <div className="en">{e.en}</div>
        </div>
      ))}
    </div>
  );
}

export default function GrammarTopic() {
  const { slug = '' } = useParams();
  const state = useAsync(async () => {
    const topic = await getTopic(slug);
    if (!topic) return null;
    const ids = await wordsForTopic(topic.id);
    const words = [...(await getWordsByIds(ids)).values()];
    return { topic, words };
  }, [slug]);

  if (state.loading) return <div className="loading">Loading lesson…</div>;
  if (state.error) return <div className="alert">{state.error}</div>;
  if (!state.data) return <div className="notice">Lesson not found. <Link to="/grammar">All grammar</Link></div>;

  const { topic, words } = state.data;
  const c = topic.content;

  return (
    <article className="narrow">
      <Link to="/grammar" className="btn btn-ghost" style={{ paddingLeft: 0 }}>← Grammar</Link>
      <div className="card" style={{ marginTop: 8 }}>
        <span className="pill">{topic.cefr_level}</span>
        <h1 style={{ marginTop: 10 }}>{topic.title}</h1>
        <p className="muted">{topic.summary}</p>

        {!c ? (
          <div className="notice">This topic is on the curriculum outline. The full lesson comes in a later version.</div>
        ) : (
          <>
            <section className="lesson-section">
              <h3>What is it?</h3>
              <p>{c.what}</p>
            </section>
            <section className="lesson-section">
              <h3>Practical rule</h3>
              <p className="pre-line">{c.rule}</p>
            </section>
            <section className="lesson-section">
              <h3>Examples</h3>
              <Examples items={c.examples} />
            </section>
            <section className="lesson-section">
              <h3>Common mistake</h3>
              <div className="mistake">
                <span className="wrong" lang="de">{c.mistake.wrong}</span>
                <span className="right" lang="de">{c.mistake.right}</span>
                <span className="muted small">{c.mistake.why}</span>
              </div>
            </section>
            <section className="lesson-section">
              <h3>Everyday German</h3>
              <Examples items={c.everyday} />
            </section>
            <section className="lesson-section">
              <h3>Remember</h3>
              <div className="remember">{c.remember}</div>
            </section>
          </>
        )}

        {words.length > 0 && (
          <section className="lesson-section">
            <h3>Words that use this</h3>
            <div>
              {words.map((w) => (
                <span key={w.id} className="pill" style={{ margin: 3 }} lang="de">{displayGerman(w)}</span>
              ))}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}
