import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useUIStore } from '../store/uiStore';

// AppShell wires a few subsystems (WebSocket via useNotifications,
// the notification bell, the sidebar nav). The s-1203 surface
// we're pinning here is the theme toggle button (moved to the
// sidebar footer in s-1282), so we stub the rest to keep the
// test focused on just that.
vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => undefined
}));

vi.mock('./NotificationBell', () => ({
  NotificationBell: () => (
    <div
      data-testid="notification-bell-stub"
      className="h-9 w-9 rounded-md border border-zinc-200 bg-white"
    />
  )
}));

// s-1282: AppShell mounts the theme toggle and the notification
// bell inside the sidebar's footer slot, so the stub has to forward
// `footer` to keep them visible in the DOM.
vi.mock('./Sidebar', () => ({
  Sidebar: ({ footer }: { footer?: React.ReactNode }) => (
    <div data-testid="sidebar-stub">{footer}</div>
  )
}));

import { AppShell } from './AppShell';

function renderShell() {
  return render(
    <MemoryRouter>
      <AppShell>
        <div>child</div>
      </AppShell>
    </MemoryRouter>
  );
}

describe('AppShell theme toggle in sidebar footer (s-1203 / s-1282)', () => {
  beforeEach(() => {
    // Reset dark-mode + persisted localStorage between tests so the
    // toggle assertions don't leak state across cases.
    localStorage.removeItem('darkMode');
    useUIStore.setState({ darkMode: false });
    document.documentElement.classList.remove('dark');
  });

  it('renders the sidebar theme toggle button', () => {
    renderShell();
    expect(screen.getByTestId('sidebar-theme-toggle')).toBeInTheDocument();
  });

  it('flips darkMode on click', () => {
    renderShell();
    const btn = screen.getByTestId('sidebar-theme-toggle');
    expect(useUIStore.getState().darkMode).toBe(false);
    fireEvent.click(btn);
    expect(useUIStore.getState().darkMode).toBe(true);
  });

  it('flips back off on second click', () => {
    renderShell();
    const btn = screen.getByTestId('sidebar-theme-toggle');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(useUIStore.getState().darkMode).toBe(false);
  });

  it('reflects the current darkMode state in aria-pressed', async () => {
    useUIStore.setState({ darkMode: true });
    renderShell();
    expect(screen.getByTestId('sidebar-theme-toggle')).toHaveAttribute('aria-pressed', 'true');
    act(() => {
      useUIStore.setState({ darkMode: false });
    });
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-theme-toggle')).toHaveAttribute('aria-pressed', 'false')
    );
  });

  it('exposes an accessible name that adapts to the next action', () => {
    renderShell();
    // Light mode is active → label hints "switch to dark".
    expect(screen.getByTestId('sidebar-theme-toggle')).toHaveAttribute(
      'aria-label',
      'darkMode.switchToDark'
    );
    fireEvent.click(screen.getByTestId('sidebar-theme-toggle'));
    // Dark mode now active → label hints "switch to light".
    expect(screen.getByTestId('sidebar-theme-toggle')).toHaveAttribute(
      'aria-label',
      'darkMode.switchToLight'
    );
  });

  it('places the theme toggle next to the notification bell inside the sidebar footer (s-1282)', () => {
    renderShell();
    const toggle = screen.getByTestId('sidebar-theme-toggle');
    const bell = screen.getByTestId('notification-bell-stub');
    // Both must share the same flex parent (the sidebar footer slot)
    // so they line up vertically beneath the navigation items.
    expect(toggle.parentElement).toBe(bell.parentElement);
    // And both must live inside the sidebar itself, not in any
    // top-of-page toolbar — the original position overlapped the
    // Boards / Dashboard / per-board toolbars and was unreliable.
    const sidebar = screen.getByTestId('sidebar-stub');
    expect(sidebar.contains(toggle)).toBe(true);
    expect(sidebar.contains(bell)).toBe(true);
  });

  it('matches the notification bell size so the icons stay visually aligned (s-1250)', () => {
    renderShell();
    const toggle = screen.getByTestId('sidebar-theme-toggle');
    const bell = screen.getByTestId('notification-bell-stub');
    // Both buttons must share the same box (h-9 w-9) so their icons
    // line up vertically beneath the nav items.
    expect(toggle.className).toContain('h-9');
    expect(toggle.className).toContain('w-9');
    expect(bell.className).toContain('h-9');
    expect(bell.className).toContain('w-9');
    // The theme toggle must also surface a visible chrome (border +
    // background) to match the bell — otherwise it floats differently.
    expect(toggle.className).toContain('border');
    expect(toggle.className).toContain('bg-white');
  });
});