import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SetupPage, pickSupportedDbType } from './SetupPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      // Minimal translations for the keys the tests assert against.
      const map: Record<string, string> = {
        'setup.advancedSettings': 'Advanced Settings',
        'setup.dbType': 'Database Type',
        'setup.dbTypeFixed': 'Database Type (locked to {{type}} by this build)',
        'setup.dbPath': 'Database File Path',
        'setup.dbHost': 'Database Host',
        'setup.dbPort': 'Port',
        'setup.dbName': 'Database Name',
        'setup.dbUser': 'Username',
        'setup.dbPassword': 'Password',
        'setup.serverPort': 'Port',
        'setup.allowedOrigins': 'Allowed Origins (CORS)',
      };
      let out = map[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          out = out.replace(`{{${k}}}`, String(v));
        }
      }
      return out;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/services/api', () => ({
  authApi: {
    me: vi.fn().mockResolvedValue({ user: null, needsSetup: true }),
    getInitDefaults: vi.fn(),
    init: vi.fn(),
  },
}));

import { authApi } from '@/services/api';

function renderSetup() {
  return render(
    <MemoryRouter>
      <SetupPage />
    </MemoryRouter>
  );
}

describe('pickSupportedDbType', () => {
  it('returns the requested type when it is supported', () => {
    expect(pickSupportedDbType('mysql', ['mysql'], 'sqlite')).toBe('mysql');
    expect(pickSupportedDbType('sqlite', ['sqlite', 'mysql'], 'sqlite')).toBe('sqlite');
  });

  it('falls back to the first supported type when the requested one is not', () => {
    // User asked for SQLite but the binary is MySQL-only.
    expect(pickSupportedDbType('sqlite', ['mysql'], 'sqlite')).toBe('mysql');
  });

  it('falls back to the provided default when no supported list is given', () => {
    expect(pickSupportedDbType('mysql', undefined, 'sqlite')).toBe('mysql');
  });

  it('falls back to the provided default when the supported list is empty', () => {
    expect(pickSupportedDbType('mysql', [], 'sqlite')).toBe('mysql');
  });

  it('defaults unknown raw values to sqlite, then applies supported filter', () => {
    expect(pickSupportedDbType(undefined, ['mysql'], 'sqlite')).toBe('mysql');
    expect(pickSupportedDbType('postgres', ['sqlite', 'mysql'], 'sqlite')).toBe('sqlite');
  });
});

describe('SetupPage dbType selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides unsupported options and locks the dropdown for a MySQL-only build', async () => {
    (authApi.getInitDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({
      dbType: 'mysql',
      dbHost: 'db',
      dbPort: '3306',
      dbUser: 'u',
      dbPassword: '',
      dbName: 'kanban',
      serverPort: '8080',
      allowedOrigins: '',
      supportedDbTypes: ['mysql'],
    });

    renderSetup();

    // Wait for the prefill to resolve and the single-engine rendering
    // to take over, then verify: (a) the collapse toggle is gone, and
    // (b) the dropdown is already in the DOM (the form is forced open).
    await waitFor(() => {
      expect(screen.queryByText(/Advanced Settings/i)).toBeNull();
    });

    await waitFor(() => {
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      // Only the MySQL option should be present.
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toEqual(['mysql']);
      // And the control must be disabled so users can't bypass the filter.
      expect(select.disabled).toBe(true);
      expect(select.value).toBe('mysql');
    });
  });

  it('keeps the advanced form collapsed by default when both drivers are available', async () => {
    (authApi.getInitDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({
      dbType: 'sqlite',
      dbPath: 'kanban.db',
      dbHost: 'localhost',
      dbPort: '3306',
      dbUser: 'root',
      dbPassword: '',
      dbName: 'kanban',
      serverPort: '8080',
      allowedOrigins: '',
      supportedDbTypes: ['sqlite', 'mysql'],
    });

    renderSetup();

    // Wait for the prefill to settle, then verify the form is collapsed
    // (no <select> in the DOM yet) and the toggle is visible.
    await screen.findByText(/Advanced Settings/i);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('pre-fills allowedOrigins with the current origin when the server has no value', async () => {
    (authApi.getInitDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({
      dbType: 'mysql',
      dbHost: 'db',
      dbPort: '3306',
      dbUser: 'u',
      dbPassword: '',
      dbName: 'kanban',
      serverPort: '8080',
      // Server has no ALLOWED_ORIGINS — frontend should fill in the
      // browser's own origin so the operator is not locked out of
      // cross-origin API calls right after init.
      allowedOrigins: '',
      supportedDbTypes: ['mysql'],
    });

    renderSetup();

    // The MySQL-only build forces the advanced form open, so the
    // allowedOrigins <input> is in the DOM immediately. Read it via
    // the input's label.
    await waitFor(() => {
      const input = screen.getByLabelText(/Allowed Origins \(CORS\)/i) as HTMLInputElement;
      // jsdom's default origin is http://localhost:3000.
      expect(input.value).toBe(window.location.origin);
    });
  });

  it('keeps the server-supplied allowedOrigins when one is configured', async () => {
    (authApi.getInitDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({
      dbType: 'mysql',
      dbHost: 'db',
      dbPort: '3306',
      dbUser: 'u',
      dbPassword: '',
      dbName: 'kanban',
      serverPort: '8080',
      // Operator pre-configured ALLOWED_ORIGINS — respect their value
      // and don't overwrite it with the browser origin.
      allowedOrigins: 'https://app.example.com,https://admin.example.com',
      supportedDbTypes: ['mysql'],
    });

    renderSetup();

    await waitFor(() => {
      const input = screen.getByLabelText(/Allowed Origins \(CORS\)/i) as HTMLInputElement;
      expect(input.value).toBe('https://app.example.com,https://admin.example.com');
    });
  });

  it('exposes both options when the build supports both', async () => {
    (authApi.getInitDefaults as ReturnType<typeof vi.fn>).mockResolvedValue({
      dbType: 'sqlite',
      dbPath: 'kanban.db',
      dbHost: 'localhost',
      dbPort: '3306',
      dbUser: 'root',
      dbPassword: '',
      dbName: 'kanban',
      serverPort: '8080',
      allowedOrigins: '',
      supportedDbTypes: ['sqlite', 'mysql'],
    });

    renderSetup();

    const advancedBtn = await screen.findByText(/Advanced Settings/i);
    advancedBtn.click();

    await waitFor(() => {
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toEqual(['sqlite', 'mysql']);
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('sqlite');
    });
  });
});
