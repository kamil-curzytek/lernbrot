import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { authReady } from './lib/supabase/client';
import './styles.css';

// Let Supabase read email-link tokens from the URL before the hash router takes over the hash.
authReady().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>,
  );
});
