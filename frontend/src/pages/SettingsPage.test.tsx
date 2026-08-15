import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' }
  })
}));

vi.mock('../hooks/useSetupGuard', () => ({ useSetupGuard: () => undefined }));

const { authApiMock } = vi.hoisted(() => ({
  authApiMock: {
    me: vi.fn(),
    getTokens: vi.fn().mockResolvedValue({ tokens: [] }),
    getUsers: vi.fn().mockResolvedValue([])
  }
}));

vi.mock('../services/api', () => ({ authApi: authApiMock }));

import { SettingsPage } from './SettingsPage';

function renderAtTab(initialTab?: string) {
  const initial = initialTab ? `/settings?tab=${initialTab}` : '/settings';
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/" element={<div>home-stub</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('SettingsPage tab URL sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authApiMock.me.mockResolvedValue({
      user: {
        id: 'u1',
        username: 'admin',
        nickname: 'Admin',
        role: 'ADMIN',
        type: 'HUMAN',
        enabled: true
      }
    });
    authApiMock.getUsers.mockResolvedValue([]);
  });

  // Sidebar buttons all have a non-unique label because the right pane
  // shows the same t() key. Anchor every assertion to the <button>
  // ancestor with the active class instead of using getByText.
  const profileBtn = () => screen.getByRole('button', { name: 'settings.profile' });

  it('honours ?tab=users on first render', async () => {
    renderAtTab('users');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'settings.users' })).toHaveClass('bg-blue-100')
    );
  });

  it('honours ?tab=oauth on first render', async () => {
    renderAtTab('oauth');
    await waitFor(() =>
      expect(screen.getByTestId('tab-oauth')).toHaveClass('bg-blue-100')
    );
  });

  it('defaults to profile when no tab is present', async () => {
    renderAtTab();
    await waitFor(() => expect(profileBtn()).toHaveClass('bg-blue-100'));
  });

  it('ignores unknown tab values and falls back to profile', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=evil-tab']}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/" element={<div>home-stub</div>} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(profileBtn()).toHaveClass('bg-blue-100'));
  });

  it('switches active tab when a different tab is clicked', async () => {
    renderAtTab('profile');
    await waitFor(() => expect(profileBtn()).toHaveClass('bg-blue-100'));

    fireEvent.click(screen.getByTestId('tab-oauth'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-oauth')).toHaveClass('bg-blue-100');
    });

    expect(profileBtn()).not.toHaveClass('bg-blue-100');
  });

  it('reflects the active tab for every tab kind', async () => {
    const tabs: Array<{ name: string; selector?: string }> = [
      { name: 'settings.tokens' },
      { name: 'settings.activitiesTitle' },
      { name: 'settings.agents' },
      { name: 'settings.users' },
      { name: 'settings.shortcuts' },
      { name: 'oauth.admin.title', selector: '[data-testid="tab-oauth"]' },
      { name: 'nav.theme' }
    ];

    for (const tab of tabs) {
      const { unmount } = renderAtTab('profile');
      await waitFor(() => expect(profileBtn()).toHaveClass('bg-blue-100'));
      const element = tab.selector
        ? document.querySelector(tab.selector) as HTMLElement
        : screen.getByRole('button', { name: tab.name });
      fireEvent.click(element);
      await waitFor(() => {
        expect(element).toHaveClass('bg-blue-100');
      });
      expect(profileBtn()).not.toHaveClass('bg-blue-100');
      unmount();
    }
  });
});