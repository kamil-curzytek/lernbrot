// Dashboard numbers, derived deterministically from rows in Supabase.
// Session *selection* lives in SQL (create_daily_session_for) so the cloud job
// and the app share one implementation.

import type { ProgressStatus, VocabularyProgress } from '../../types';
import { addDays } from '../time';

/** Consecutive days with a completed session, ending today (or yesterday, if today isn't done yet). */
export function currentStreak(completedDates: readonly string[], today: string): number {
  const done = new Set(completedDates);
  let day = done.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (done.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

export interface ProgressSummary {
  /** Words answered correctly at least once. */
  learned: number;
  /** Words whose next review is due now. */
  due: number;
  byStatus: Record<ProgressStatus, number>;
}

export function summarizeProgress(rows: readonly VocabularyProgress[], now: Date = new Date()): ProgressSummary {
  const byStatus: Record<ProgressStatus, number> = { new: 0, learning: 0, familiar: 0, strong: 0, review: 0 };
  let learned = 0;
  let due = 0;
  for (const r of rows) {
    byStatus[r.status]++;
    if (r.times_correct > 0) learned++;
    if (r.next_review_at && Date.parse(r.next_review_at) <= now.getTime()) due++;
  }
  return { learned, due, byStatus };
}

export function greeting(hour: number): string {
  if (hour < 5) return 'Good evening.';
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}
