import { useApp } from '../AppContext';
import { createDailySession, getSessionItems } from '../services/dailySessionService';
import { useAsync } from './useAsync';

/** Today's session (created on first call, or already prepared by the daily cloud job). */
export function useTodaySession() {
  const { user, profile } = useApp();
  return useAsync(async () => {
    const session = await createDailySession(user.id);
    const items = await getSessionItems(session.id);
    return { session, items };
  }, [user.id, profile.timezone]);
}
