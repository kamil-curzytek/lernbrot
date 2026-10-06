import { useState, type FormEvent } from 'react';
import { isCorrect, type QuizQuestion } from '../../lib/quiz';

interface Props {
  question: QuizQuestion;
  answer: string | undefined;
  onAnswer: (answer: string) => void;
}

/** Renders one question. Once answered it shows feedback and locks. */
export function QuestionView({ question: q, answer, onAnswer }: Props) {
  const [draft, setDraft] = useState('');
  const answered = answer !== undefined;
  const ok = answered && isCorrect(q, answer);
  const isSentence = q.type === 'context' || q.type === 'fill_blank';

  function submitTyped(e: FormEvent) {
    e.preventDefault();
    if (!answered && draft.trim()) onAnswer(draft.trim());
  }

  return (
    <div className="card">
      <div className="q-instruction">{q.instruction}</div>
      <div className={`q-prompt ${isSentence ? 'sentence' : ''}`} lang={q.type === 'de_en' || isSentence || q.type === 'article' || q.type === 'plural' ? 'de' : 'en'}>
        {q.prompt}
      </div>
      {q.helper && <div className="q-helper">{q.helper}</div>}

      {q.format === 'choice' ? (
        <div className={q.options!.length === 3 ? 'choice-row' : 'choice-grid'}>
          {q.options!.map((o) => {
            const state = !answered ? '' : o === q.correctAnswer ? 'correct' : o === answer ? 'wrong' : '';
            return (
              <button key={o} className={`choice ${state}`} disabled={answered} onClick={() => onAnswer(o)}>
                {o}
              </button>
            );
          })}
        </div>
      ) : (
        <form onSubmit={submitTyped} className="row">
          <input
            className="input spacer"
            style={{ minWidth: 0 }}
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            lang="de"
            placeholder="Type your answer"
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
      )}

      {answered && (
        <div className={`feedback ${ok ? 'ok' : 'no'}`} role="status">
          {ok ? '✓ Correct' : <>✗ The answer is <strong lang="de">{q.correctAnswer}</strong>{q.hint && <div className="rule-note">{q.hint}</div>}</>}
        </div>
      )}
    </div>
  );
}
