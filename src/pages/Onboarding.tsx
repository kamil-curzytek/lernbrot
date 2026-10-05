import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SignOutButton } from '../components/layout/AppShell';
import { supabase } from '../lib/supabase/client';
import { browserTimeZone } from '../lib/time';
import { completeOnboarding } from '../services/profileService';
import type { CefrLevel, Profile } from '../types';

const LEVELS: { label: string; level: CefrLevel; hint: string }[] = [
  { label: 'Complete beginner', level: 'A1', hint: 'Start from zero' },
  { label: 'A1', level: 'A1', hint: 'I know a few basics' },
  { label: 'A2', level: 'A2', hint: 'I can handle simple situations' },
  { label: 'B1', level: 'B1', hint: 'I can get by in most situations' },
  { label: 'B2', level: 'B2', hint: 'I want to sound more natural' },
];

const TARGETS = [5, 10, 15, 20];

export default function Onboarding({ userId, onDone }: { userId: string; onDone: (p: Profile) => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [choice, setChoice] = useState<number | null>(null);
  const [target, setTarget] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    if (choice === null) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await completeOnboarding(userId, LEVELS[choice].level, target, browserTimeZone());
      navigate('/lesson', { replace: true });
      onDone(profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="main narrow">
      <div className="stack" style={{ marginTop: '6vh' }}>
        <div>
          <div className="row">
            <p className="muted small" style={{ margin: 0 }}>Step {step} of 2</p>
            <span className="spacer" />
            <SignOutButton onSignOut={async () => { await supabase!.auth.signOut(); }} />
          </div>
          <h1>Learn German, one useful step at a time.</h1>
        </div>

        {step === 1 ? (
          <div className="card stack">
            <h2>What's your level?</h2>
            <div className="choice-grid">
              {LEVELS.map((l, i) => (
                <button key={l.label} className={`choice ${choice === i ? 'correct' : ''}`} onClick={() => setChoice(i)}>
                  <strong>{l.label}</strong>
                  <span className="muted small"> · {l.hint}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-primary btn-block" disabled={choice === null} onClick={() => setStep(2)}>
              Continue
            </button>
          </div>
        ) : (
          <div className="card stack">
            <h2>How many words per day?</h2>
            <div className="segmented">
              {TARGETS.map((t) => (
                <button key={t} className={target === t ? 'selected' : ''} onClick={() => setTarget(t)}>
                  {t}
                  {t === 10 && <div className="small muted">recommended</div>}
                </button>
              ))}
            </div>
            <p className="muted small">You can change this later in Progress.</p>
            {error && <div className="alert">{error}</div>}
            <div className="row">
              <button className="btn" onClick={() => setStep(1)} disabled={busy}>
                Back
              </button>
              <button className="btn btn-primary spacer" onClick={finish} disabled={busy}>
                {busy ? 'Preparing your first lesson…' : "Start today's lesson"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
