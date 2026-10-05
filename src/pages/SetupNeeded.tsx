export default function SetupNeeded() {
  return (
    <div className="main narrow stack">
      <h1>Connect Supabase</h1>
      <p>
        Lernbrot stores everything (your account, progress and review schedule) in Supabase. This build
        has no Supabase project configured, so it cannot run yet.
      </p>
      <div className="card stack">
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>Create a Supabase project and run the SQL in <code>supabase/migrations</code> and <code>supabase/seed/content.sql</code>.</li>
          <li>
            Copy <code>.env.example</code> to <code>.env.local</code> and set <code>VITE_SUPABASE_URL</code> and{' '}
            <code>VITE_SUPABASE_ANON_KEY</code>.
          </li>
          <li>Restart <code>npm run dev</code>, or rebuild.</li>
        </ol>
      </div>
      <p className="muted small">The README has the full setup steps.</p>
    </div>
  );
}
