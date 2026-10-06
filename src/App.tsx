import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AppContext } from './AppContext';
import { AppShell } from './components/layout/AppShell';
import { isSupabaseConfigured, openedFromPasswordResetLink, supabase } from './lib/supabase/client';
import AuthPage from './pages/Auth';
import Dashboard from './pages/Dashboard';
import DailyLesson from './pages/DailyLesson';
import Grammar from './pages/Grammar';
import GrammarTopic from './pages/GrammarTopic';
import Onboarding from './pages/Onboarding';
import Progress from './pages/Progress';
import Quiz from './pages/Quiz';
import ResetPassword from './pages/ResetPassword';
import Review from './pages/Review';
import SetupNeeded from './pages/SetupNeeded';
import Vocabulary from './pages/Vocabulary';
import { getProfile } from './services/profileService';
import type { Profile } from './types';

export default function App() {
  if (!isSupabaseConfigured || !supabase) return <SetupNeeded />;
  return <AuthedApp />;
}

function AuthedApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  // opened from a "reset your password" email: ask for the new password first
  const [recovering, setRecovering] = useState(openedFromPasswordResetLink);

  useEffect(() => {
    supabase!.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase!.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    setProfile(null);
    setProfileError(null);
    if (!userId) return;
    getProfile(userId).then(setProfile, (e: Error) => setProfileError(e.message));
  }, [userId]);

  if (session === undefined) return <div className="loading">Loading…</div>;
  if (!session) return <AuthPage />;
  if (recovering) return <ResetPassword email={session.user.email} onDone={() => setRecovering(false)} />;
  if (profileError) {
    return (
      <div className="main narrow">
        <div className="alert">Could not load your profile: {profileError}</div>
      </div>
    );
  }
  if (!profile) return <div className="loading">Loading your profile…</div>;
  if (!profile.onboarded_at) return <Onboarding userId={session.user.id} onDone={setProfile} />;

  const state = {
    user: session.user,
    profile,
    setProfile,
    signOut: async () => {
      await supabase!.auth.signOut();
    },
  };

  return (
    <AppContext.Provider value={state}>
      <AppShell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/lesson" element={<DailyLesson />} />
          <Route path="/quiz" element={<Quiz />} />
          <Route path="/grammar" element={<Grammar />} />
          <Route path="/grammar/:slug" element={<GrammarTopic />} />
          <Route path="/vocabulary" element={<Vocabulary />} />
          <Route path="/review" element={<Review />} />
          <Route path="/progress" element={<Progress />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </AppContext.Provider>
  );
}
