import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useApp } from '../../AppContext';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/grammar', label: 'Grammar' },
  { to: '/vocabulary', label: 'Vocabulary' },
  { to: '/review', label: 'Review' },
  { to: '/progress', label: 'Progress' },
];

export function SignOutButton({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn-ghost signout"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onSignOut();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useApp();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            German<span>izer</span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="account" title={user.email ?? undefined}>
            <SignOutButton onSignOut={signOut} />
          </div>
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
