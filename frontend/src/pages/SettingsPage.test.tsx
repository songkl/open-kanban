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

  // s-1199: tabs are now exposed via the ARIA `tab` role instead of the
  // generic `button` role. The accessible name still comes from the
  // visible label via the text content, so getByRole('tab', { name })
  // finds the same element the user sees.
  const profileBtn = () => screen.getByRole('tab', { name: 'settings.profile' });

  it('honours ?tab=users on first render', async () => {
    renderAtTab('users');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'settings.users' })).toHaveClass('bg-blue-100')
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
        : screen.getByRole('tab', { name: tab.name });
      fireEvent.click(element);
      await waitFor(() => {
        expect(element).toHaveClass('bg-blue-100');
      });
      expect(profileBtn()).not.toHaveClass('bg-blue-100');
      unmount();
    }
  });

  it('applies consistent active styling in both light and dark mode', async () => {
    // Light mode: classic blue highlight
    renderAtTab('profile');
    const lightActive = await waitFor(() => screen.getByRole('tab', { name: 'settings.profile' }));
    expect(lightActive).toHaveClass('bg-blue-100');
    expect(lightActive).toHaveClass('text-blue-700');
    // The `transition-colors` utility smooths the active/inactive swap so the
    // user does not see a hard flash when clicking a tab.
    expect(lightActive.className.split(/\s+/)).toContain('transition-colors');

    // Dark mode: muted blue tint that doesn't flash against the dark sidebar.
    // The active button must include the dark variant of bg/text classes.
    document.documentElement.classList.add('dark');
    try {
      const darkActive = await waitFor(() => screen.getByRole('tab', { name: 'settings.profile' }));
      expect(darkActive.className).toMatch(/dark:bg-blue-900\/40/);
      expect(darkActive.className).toMatch(/dark:text-blue-300/);
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('does not change sidebar width when switching tabs', async () => {
    // Regression guard for the "width flashes on tab switch" bug.
    // The sidebar and each tab button must keep the same width regardless of
    // which tab is active, so the layout cannot shimmer between clicks.
    const tabs: Array<{ name: string; selector?: string }> = [
      { name: 'settings.profile' },
      { name: 'settings.tokens' },
      { name: 'settings.activitiesTitle' },
      { name: 'settings.agents' },
      { name: 'settings.users' },
      { name: 'settings.shortcuts' },
      { name: 'oauth.admin.title', selector: '[data-testid="tab-oauth"]' },
      { name: 'nav.theme' }
    ];

    renderAtTab('profile');
    await waitFor(() => expect(profileBtn()).toHaveClass('bg-blue-100'));

    const measureSidebar = () => {
      const sidebar = document.querySelector('[role="tablist"]')?.parentElement;
      const buttons = document.querySelectorAll('[role="tablist"] [role="tab"]');
      const sidebarRect = sidebar?.getBoundingClientRect();
      const widths = Array.from(buttons).map((b) => (b as HTMLElement).getBoundingClientRect().width);
      return {
        sidebarWidth: sidebarRect?.width,
        buttonWidths: widths
      };
    };

    const baseline = measureSidebar();

    for (const tab of tabs) {
      const element = tab.selector
        ? document.querySelector(tab.selector) as HTMLElement
        : screen.getByRole('tab', { name: tab.name });
      fireEvent.click(element);
      await waitFor(() => expect(element).toHaveClass('bg-blue-100'));
      const measured = measureSidebar();
      expect(measured.sidebarWidth).toBe(baseline.sidebarWidth);
      expect(measured.buttonWidths).toEqual(baseline.buttonWidths);
    }
  });

  describe('a11y (s-1199)', () => {
    it('renders the sidebar as a vertical tablist', async () => {
      renderAtTab();
      await waitFor(() => expect(profileBtn()).toHaveClass('bg-blue-100'));
      const tablist = screen.getByRole('tablist');
      expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
      expect(tablist).toHaveAccessibleName('settings.title');
    });

    it('marks only the active tab with aria-selected', async () => {
      renderAtTab();
      await waitFor(() => expect(profileBtn()).toHaveClass('bg-blue-100'));
      expect(profileBtn()).toHaveAttribute('aria-selected', 'true');
      const tokensTab = screen.getByRole('tab', { name: 'settings.tokens' });
      expect(tokensTab).toHaveAttribute('aria-selected', 'false');
    });

    it('exposes the tabpanel with aria-labelledby pointing at the active tab', async () => {
      renderAtTab('users');
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: 'settings.users' })).toHaveClass('bg-blue-100')
      );
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('id', 'settings-panel-users');
      expect(panel).toHaveAttribute('aria-labelledby', 'settings-tab-users');
    });

    it('moves focus between tabs with ArrowRight / ArrowLeft', async () => {
      renderAtTab();
      await waitFor(() => expect(profileBtn()).toHaveClass('bg-blue-100'));
      profileBtn().focus();
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'settings.tokens' }));
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(profileBtn());
    });
  });
});