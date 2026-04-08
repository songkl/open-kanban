import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './i18n'
import App from './App.tsx'
import './styles/globals.css'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
