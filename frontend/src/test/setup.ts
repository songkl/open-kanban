import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock react-i18next. We expose both the hook our components use and
// the init helper that `src/i18n/index.ts` calls at module load — the
// hook alone is not enough because several modules transitively import
// the i18n bootstrap (most notably `src/services/api.ts` for its
// `t('app.error.*')` lookups). Without `initReactI18next` in the mock,
// any test that loads `api.ts` via a component chain explodes on
// `i18n.use(initReactI18next)` with "no export defined".
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty' },
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

window.alert = vi.fn();
window.prompt = vi.fn();
