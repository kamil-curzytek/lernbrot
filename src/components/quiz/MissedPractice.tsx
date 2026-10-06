import { useState } from 'react';
import { isCorrect, type QuizQuestion } from '../../lib/quiz';
import { QuestionView } from './QuestionView';

/** How many extra rounds a missed word may get before the results are shown. */
export const MAX_PRACTICE_ROUNDS = 2;

interface Props {
  missed: QuizQuestion[];
  onDone: () => void;
}

/**
 * Successive relearning: after the scored quiz, words answered wrong are asked again until they are
 * answered correctly (at most MAX_PRACTICE_ROUNDS rounds). Unscored and not saved: the score and the
 * schedule were already stored, so this practice can only help memory, never change results.
 */
export function MissedPractice({ missed, onDone }: Props) {
  const [round, setRound] = useState(1);
  const [queue, setQueue] = useState(missed);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const q = queue[index];
  const answer = answers[q.id];
  const answered = answer !== undefined;
  const lastInRound = index === queue.length - 1;

  function next() {
    if (!lastInRound) {
      setIndex(index + 1);
      return;
    }
    const stillWrong = queue.filter((x) => !isCorrect(x, answers[x.id] ?? ''));
    if (stillWrong.length === 0 || round >= MAX_PRACTICE_ROUNDS) {
      onDone();
      return;
    }
    setRound(round + 1);
    setQueue(stillWrong);
    setIndex(0);
    setAnswers({});
  }

  return (
    <div className="narrow stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>Practise the words you missed</h2>
        <span className="spacer" />
        <span className="muted small">
          {index + 1} / {queue.length}
          {round > 1 ? ` · round ${round}` : ''}
        </span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Your score is already saved. Getting these right now helps you remember them tomorrow.
      </p>

      <QuestionView
        key={`${round}-${q.id}`}
        question={q}
        answer={answer}
        onAnswer={(a) => setAnswers((prev) => ({ ...prev, [q.id]: a }))}
      />

      {answered && (
        <button className="btn btn-primary btn-lg btn-block" onClick={next} autoFocus>
          {lastInRound ? 'Continue' : 'Next'}
        </button>
      )}
      <button className="btn btn-ghost btn-block" onClick={onDone}>
        Skip to results
      </button>
    </div>
  );
}
