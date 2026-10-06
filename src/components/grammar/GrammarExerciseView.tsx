import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { isGrammarCorrect, solvedSentence, type GrammarExercise } from '../../lib/grammar';

interface Props {
  exercise: GrammarExercise;
  answer: string | undefined;
  onAnswer: (answer: string) => void;
  /** Show a link to the lesson in the feedback (not on the lesson page itself). */
  linkToLesson?: boolean;
}

/** One grammar exercise. Once answered it locks and explains the rule when the answer was wrong. */
export function GrammarExerciseView({ exercise: ex, answer, onAnswer, linkToLesson = false }: Props) {
  const answered = answer !== undefined;
  const ok = answered && isGrammarCorrect(ex, answer);

  return (
    <div className="card">
      <div className="q-instruction">{ex.instruction}</div>
      {ex.format !== 'order' && (
        <div className="q-prompt sentence" lang="de">
          {ex.prompt}
        </div>
      )}
      <div className="q-helper">{ex.helper}</div>

      {ex.format === 'choice' && <Choice ex={ex} answer={answer} onAnswer={onAnswer} />}
      {ex.format === 'typed' && <Typed answered={answered} answer={answer} onAnswer={onAnswer} />}
      {ex.format === 'order' && <Order ex={ex} answer={answer} onAnswer={onAnswer} />}

      {answered && (
        <div className={`feedback ${ok ? 'ok' : 'no'}`} role="status">
          {ok ? (
            <>✓ Correct</>
          ) : (
            <>
              ✗ Correct: <strong lang="de">{solvedSentence(ex)}</strong>
              <div className="rule-note">{ex.explanation}</div>
              {linkToLesson && (
                <Link to={`/grammar/${ex.topic}`} className="small">
                  Open the lesson →
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Choice({ ex, answer, onAnswer }: { ex: GrammarExercise; answer: string | undefined; onAnswer: (a: string) => void }) {
  const answered = answer !== undefined;
  return (
    <div className={ex.options!.length <= 3 && ex.options!.every((o) => o.length <= 14) ? 'choice-row' : 'choice-grid'}>
      {ex.options!.map((o) => {
        const state = !answered ? '' : o === ex.correctAnswer ? 'correct' : o === answer ? 'wrong' : '';
        return (
          <button key={o} className={`choice ${state}`} disabled={answered} onClick={() => onAnswer(o)} lang="de">
            {o}
          </button>
        );
      })}
    </div>
  );
}

function Typed({ answered, answer, onAnswer }: { answered: boolean; answer: string | undefined; onAnswer: (a: string) => void }) {
  const [draft, setDraft] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!answered && draft.trim()) onAnswer(draft.trim());
  }
  return (
    <form onSubmit={submit} className="row">
      <input
        className="input spacer"
        style={{ minWidth: 0 }}
        autoFocus
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        lang="de"
        placeholder="Type the missing word"
        value={answered ? answer : draft}
        disabled={answered}
        onChange={(e) => setDraft(e.target.value)}
      />
      {!answered && (
        <button className="btn btn-primary" disabled={!draft.trim()}>
          Check
        </button>
      )}
    </form>
  );
}

/** Tap chunks to build the sentence; tap a placed chunk to take it back. */
function Order({ ex, answer, onAnswer }: { ex: GrammarExercise; answer: string | undefined; onAnswer: (a: string) => void }) {
  const chunks = ex.chunks!;
  const [placed, setPlaced] = useState<number[]>([]);
  const answered = answer !== undefined;
  const built = answered ? answer : placed.map((i) => chunks[i]).join(' ');
  const display = built ? built.charAt(0).toUpperCase() + built.slice(1).replace(/\s+,/g, ',') + (answered || placed.length === chunks.length ? ex.punct : '') : '';

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className={`order-line ${answered ? (isGrammarCorrect(ex, answer) ? 'correct' : 'wrong') : ''}`} lang="de" aria-live="polite">
        {display || <span className="muted small">Tap the words below in the right order.</span>}
      </div>
      {!answered && (
        <>
          <div className="chunk-bank">
            {chunks.map((c, i) => {
              const used = placed.includes(i);
              return (
                <button
                  key={i}
                  className={`chunk ${used ? 'used' : ''}`}
                  lang="de"
                  onClick={() => setPlaced(used ? placed.filter((x) => x !== i) : [...placed, i])}
                  aria-pressed={used}
                >
                  {c}
                </button>
              );
            })}
          </div>
          <div className="row">
            <button className="btn btn-ghost" onClick={() => setPlaced([])} disabled={placed.length === 0}>
              Clear
            </button>
            <span className="spacer" />
            <button
              className="btn btn-primary"
              disabled={placed.length !== chunks.length}
              onClick={() => onAnswer(placed.map((i) => chunks[i]).join(' '))}
            >
              Check
            </button>
          </div>
        </>
      )}
    </div>
  );
}
