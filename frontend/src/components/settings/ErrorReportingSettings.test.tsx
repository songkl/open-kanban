import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getConfig: vi.fn(),
    setConfig: vi.fn(),
    list: vi.fn(),
  },
}));

vi.mock('../../services/api', () => ({
  frontendEventsApi: apiMock,
}));

import { ErrorReportingSettings } from './ErrorReportingSettings';

describe('ErrorReportingSettings (s-1210)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiMock.getConfig.mockResolvedValue({ enabled: true });
    apiMock.setConfig.mockImplementation(async (enabled) => ({ enabled }));
  });

  it('hydrates the server toggle from GET on first paint (admin)', async () => {
    render(<ErrorReportingSettings isAdmin />);
    await waitFor(() => {
      expect(apiMock.getConfig).toHaveBeenCalledTimes(1);
    });
    const serverSwitch = screen.getByTestId('error-reporting-server');
    expect(serverSwitch).toHaveAttribute('aria-checked', 'true');
  });

  it('flips the server toggle and PUTs the new value', async () => {
    render(<ErrorReportingSettings isAdmin />);
    await waitFor(() => expect(screen.getByTestId('error-reporting-server')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('error-reporting-server'));
    await waitFor(() =>
      expect(apiMock.setConfig).toHaveBeenCalledWith(false)
    );
  });

  it('persists the client toggle to localStorage', async () => {
    render(<ErrorReportingSettings isAdmin={false} />);
    // Non-admin: client toggle is visible, server toggle is not.
    await waitFor(() => expect(screen.getByTestId('error-reporting-client')).toBeInTheDocument());
    expect(screen.queryByTestId('error-reporting-server')).toBeNull();
    fireEvent.click(screen.getByTestId('error-reporting-client'));
    expect(localStorage.getItem('kanban.frontendEventsEnabled')).toBe('0');
  });

  it('does not probe the server-side toggle when not admin', async () => {
    render(<ErrorReportingSettings isAdmin={false} />);
    await waitFor(() => expect(screen.getByTestId('error-reporting-client')).toBeInTheDocument());
    expect(apiMock.getConfig).not.toHaveBeenCalled();
  });

  it('surfaces an error when GET fails', async () => {
    apiMock.getConfig.mockRejectedValueOnce(new Error('boom'));
    render(<ErrorReportingSettings isAdmin />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('boom')
    );
  });
});