import { createContext, useContext } from 'react';
import type { User } from '@supabase/supabase-js';
import type { Profile } from './types';

export interface AppState {
  user: User;
  profile: Profile;
  setProfile: (p: Profile) => void;
  signOut: () => Promise<void>;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside a signed-in, onboarded app');
  return ctx;
}
