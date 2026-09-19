import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' }
  })
}));

const { prefsApiMock } = vi.hoisted(() => ({
  prefsApiMock: {
    get: vi.fn(),
    update: vi.fn()
  }
}));

vi.mock('../../services/api', () => ({
  notificationPreferencesApi: prefsApiMock
}));

import { NotificationsSettings } from './NotificationsSettings';

const basePrefs = {
  userId: 'u1',
  emailEnabled: true,
  webhookEnabled: true,
  webhookUrl: 'https://hooks.example.com/initial',
  updatedAt: '2026-09-17T12:00:00Z'
};

describe('NotificationsSettings (s-1203)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefsApiMock.get.mockResolvedValue(basePrefs);
    prefsApiMock.update.mockImplementation(async (patch) => ({
      ...basePrefs,
      ...patch,
      updatedAt: '2026-09-17T12:00:01Z'
    }));
  });

  it('renders the GET response and exposes both switches', async () => {
    render(<NotificationsSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('webhook-url-input')).toBeInTheDocument()
    );
    expect(screen.getByTestId('email-switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('webhook-switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('webhook-url-input')).toHaveValue(basePrefs.webhookUrl);
  });

  it('flips the email switch and PATCHes only emailEnabled', async () => {
    render(<NotificationsSettings />);
    await waitFor(() => expect(screen.getByTestId('email-switch')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('email-switch'));
    await waitFor(() => expect(prefsApiMock.update).toHaveBeenCalledWith({ emailEnabled: false }));
    // Partial-PUT contract: only the flipped field should travel.
    expect(prefsApiMock.update.mock.calls[0][0]).toEqual({ emailEnabled: false });
  });

  it('flips the webhook switch and PATCHes only webhookEnabled', async () => {
    render(<NotificationsSettings />);
    await waitFor(() => expect(screen.getByTestId('webhook-switch')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('webhook-switch'));
    await waitFor(() =>
      expect(prefsApiMock.update).toHaveBeenCalledWith({ webhookEnabled: false })
    );
    expect(prefsApiMock.update.mock.calls[0][0]).toEqual({ webhookEnabled: false });
  });

  it('saves the webhook URL on blur', async () => {
    render(<NotificationsSettings />);
    await waitFor(() => expect(screen.getByTestId('webhook-url-input')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('webhook-url-input'), {
      target: { value: 'https://hooks.example.com/new' }
    });
    fireEvent.blur(screen.getByTestId('webhook-url-input'));
    await waitFor(() =>
      expect(prefsApiMock.update).toHaveBeenCalledWith({
        webhookUrl: 'https://hooks.example.com/new'
      })
    );
  });

  it('does not PATCH when the URL is unchanged on blur', async () => {
    render(<NotificationsSettings />);
    await waitFor(() => expect(screen.getByTestId('webhook-url-input')).toBeInTheDocument());
    fireEvent.blur(screen.getByTestId('webhook-url-input'));
    // Allow any unrelated PUTs to settle (there shouldn't be any)
    await new Promise((r) => setTimeout(r, 10));
    expect(prefsApiMock.update).not.toHaveBeenCalled();
  });

  it('surfaces an error message when GET fails', async () => {
    prefsApiMock.get.mockRejectedValueOnce(new Error('boom'));
    render(<NotificationsSettings />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('boom')
    );
  });

  it('surfaces an error message when UPDATE fails', async () => {
    prefsApiMock.update.mockRejectedValueOnce(new Error('save exploded'));
    render(<NotificationsSettings />);
    await waitFor(() => expect(screen.getByTestId('email-switch')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('email-switch'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('save exploded')
    );
  });

  it('flashes the success message after a successful save', async () => {
    render(<NotificationsSettings />);
    await waitFor(() => expect(screen.getByTestId('webhook-switch')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('webhook-switch'));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('settings.notifications.saved')
    );
  });
});
