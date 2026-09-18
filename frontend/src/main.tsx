import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './i18n'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/globals.css'
import { registerServiceWorker } from './pwa'
import {
  createErrorReporter,
  getDefaultConfig,
} from './services/errorReporter'

const DARK_MODE_KEY = 'darkMode';

const savedDarkMode = localStorage.getItem(DARK_MODE_KEY);
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
if (savedDarkMode === 'true' || (savedDarkMode === null && prefersDark)) {
  document.documentElement.classList.add('dark');
}

if (savedDarkMode === null) {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = (e: MediaQueryListEvent) => {
    if (e.matches) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };
  mediaQuery.addEventListener('change', handleChange);
}

// Install the global error reporter before the React tree
// boots so a render-time exception during init still has a
// place to land. The reporter wires window.onerror +
// unhandledrejection; the ErrorBoundary below catches React
// render errors. Both feed the same /api/v1/frontend-events
// sink. See s-1210 (PM_REVIEW_2026-09-17 §7) for the DoD.
const bootReporter = createErrorReporter(getDefaultConfig());
bootReporter.install();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)

registerServiceWorker()
