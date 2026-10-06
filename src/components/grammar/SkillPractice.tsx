import { useState } from 'react';
import { buildExercise, isGrammarCorrect, practiceQueue, PRACTICE_CRITERION, type GrammarSkill } from '../../lib/grammar';
import { recordGrammarStudy } from '../../services/grammarPracticeService';
import type { GrammarProgress } from '../../types';
import { GrammarExerciseView } from './GrammarExerciseView';

const MAX_EXERCISES = 10;

interface Props {
  skills: GrammarSkill[];
  progress: Map<number, GrammarProgress>;
  allSkills: Map<number, GrammarSkill>;
}

/** The lesson's skills, each with a short practice round (one rule at a time, until 3 correct). */
export function SkillPractice({ skills, progress: initial, allSkills }: Props) {
  const [active, setActive] = useState<number | null>(null);
  const [round, setRound] = useState(0);
  // skills studied on this page are added locally, so the page doesn't reload
  const [progress, setProgress] = useState(initial);
  const markStudied = (id: number) =>
    setProgress((m) => new Map(m).set(id, { skill_id: id, status: 'learning' } as GrammarProgress));

  if (skills.length === 0) return null;
  const current = skills.find((s) => s.id === active);

  return (
    <section className="lesson-section">
      <h3>Practise</h3>
      {current ? (
        <PracticeRound
          key={`${current.id}-${round}`}
          skill={current}
          studied={progress.has(current.id)}
          seed={`${current.id}-${round}`}
          onClose={() => setActive(null)}
          onStudied={() => markStudied(current.id)}
        />
      ) : (
        <>
          <p className="muted small">
            Practise each rule until you get {PRACTICE_CRITERION} right. After that it comes back in your daily lessons,
            spaced out and mixed with other rules.
          </p>
          <ul className="skill-list">
            {skills.map((s) => {
              const p = progress.get(s.id);
              const missing = s.requires.filter((r) => !progress.has(r)).map((r) => allSkills.get(r)?.title).filter(Boolean);
              return (
                <li key={s.id}>
                  <div className="spacer" style={{ minWidth: 180 }}>
                    <div style={{ fontWeight: 600 }}>{s.title}</div>
                    {missing.length > 0 && !p && (
                      <div className="muted small">Easier after: {missing.join(', ')}</div>
                    )}
                  </div>
                  {p ? <span className={`pill pill-${p.status}`}>{p.status === 'learning' ? 'in your reviews' : p.status}</span> : null}
                  <button className={`btn ${p ? 'btn-ghost' : 'btn-primary'}`} onClick={() => { setActive(s.id); setRound((r) => r + 1); }}>
                    {p ? 'Practise again' : 'Practise'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function PracticeRound({ skill, studied: studiedAtStart, seed, onClose, onStudied }: {
  skill: GrammarSkill; studied: boolean; seed: string; onClose: () => void; onStudied: () => void;
}) {
  const [studied] = useState(studiedAtStart); // fixed for this round (the list may update meanwhile)
  const [queue, setQueue] = useState(() => practiceQueue(skill, seed));
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [correct, setCorrect] = useState(0);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const item = queue[index];
  const ex = buildExercise(skill, item, `${seed}-${index}`);
  const answer = answers[index];
  const answered = answer !== undefined;

  async function finish() {
    setDone(true);
    if (studied || correct < PRACTICE_CRITERION) return;
    setSaving(true);
    try {
      await recordGrammarStudy([skill.id]);
      onStudied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function answer_(a: string) {
    setAnswers((prev) => ({ ...prev, [index]: a }));
    if (isGrammarCorrect(ex, a)) setCorrect((c) => c + 1);
    // a missed exercise comes back once at the end of the round
    else if (!queue.slice(index + 1).includes(item)) setQueue((q) => [...q, item]);
  }

  function next() {
    if (correct >= PRACTICE_CRITERION || index + 1 >= Math.min(queue.length, MAX_EXERCISES)) finish();
    else setIndex(index + 1);
  }

  if (done) {
    return (
      <div className="notice stack">
        <div>
          <strong>{skill.title}</strong>: {correct} correct.
          {correct < PRACTICE_CRITERION
            ? ' Not quite there yet. Have another look at the rule above and try again later.'
            : studied
            ? ' Nice extra practice. Your review schedule stays as it is.'
            : saving
              ? ' Saving…'
              : error
                ? ` Couldn't save: ${error}`
                : ' Added to your daily lessons: it comes back from tomorrow, mixed with other rules.'}
        </div>
        <button className="btn" onClick={onClose}>Back to the list</button>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <strong>{skill.title}</strong>
        <span className="spacer" />
        <span className="muted small">{Math.min(correct, PRACTICE_CRITERION)} / {PRACTICE_CRITERION} correct</span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{skill.rule}</p>
      <GrammarExerciseView key={`${seed}-${index}`} exercise={ex} answer={answer} onAnswer={answer_} />
      {answered && (
        <button className="btn btn-primary btn-block" onClick={next} autoFocus>
          {correct >= PRACTICE_CRITERION || index + 1 >= Math.min(queue.length, MAX_EXERCISES) ? 'Finish' : 'Next'}
        </button>
      )}
      <button className="btn btn-ghost btn-block" onClick={onClose}>Stop</button>
    </div>
  );
}
