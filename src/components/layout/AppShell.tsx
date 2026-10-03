import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/grammar', label: 'Grammar' },
  { to: '/vocabulary', label: 'Vocabulary' },
  { to: '/review', label: 'Review' },
  { to: '/progress', label: 'Progress' },
];

export function AppShell({ children }: { children: ReactNode }) {
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
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
