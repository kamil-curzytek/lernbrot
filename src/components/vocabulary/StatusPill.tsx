import type { ProgressStatus } from '../../types';

const LABEL: Record<ProgressStatus, string> = {
  new: 'New',
  learning: 'Learning',
  familiar: 'Familiar',
  strong: 'Strong',
  review: 'Review',
};

export function StatusPill({ status }: { status: ProgressStatus }) {
  return <span className={`pill pill-${status}`}>{LABEL[status]}</span>;
}

export function GermanWord({ german, article }: { german: string; article: string | null }) {
  return (
    <>
      {article && <span className="article">{article} </span>}
      {german}
    </>
  );
}
