import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useUIStore } from '../store/uiStore';

// AppShell wires a few subsystems (WebSocket via useNotifications,
// the notification bell, the sidebar nav). The s-1203 surface
// we're pinning here is the new theme toggle button, so we stub
// the rest to keep the test focused on just that.
vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => undefined
}));

vi.mock('./NotificationBell', () => ({
  NotificationBell: () => <div data-testid="notification-bell-stub" />
}));

vi.mock('./Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar-stub" />
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

describe('AppShell theme toggle (s-1203)', () => {
  beforeEach(() => {
    // Reset dark-mode + persisted localStorage between tests so the
    // toggle assertions don't leak state across cases.
    localStorage.removeItem('darkMode');
    useUIStore.setState({ darkMode: false });
    document.documentElement.classList.remove('dark');
  });

  it('renders the header theme toggle button', () => {
    renderShell();
    expect(screen.getByTestId('header-theme-toggle')).toBeInTheDocument();
  });

  it('flips darkMode on click', () => {
    renderShell();
    const btn = screen.getByTestId('header-theme-toggle');
    expect(useUIStore.getState().darkMode).toBe(false);
    fireEvent.click(btn);
    expect(useUIStore.getState().darkMode).toBe(true);
  });

  it('flips back off on second click', () => {
    renderShell();
    const btn = screen.getByTestId('header-theme-toggle');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(useUIStore.getState().darkMode).toBe(false);
  });

  it('reflects the current darkMode state in aria-pressed', async () => {
    useUIStore.setState({ darkMode: true });
    renderShell();
    expect(screen.getByTestId('header-theme-toggle')).toHaveAttribute('aria-pressed', 'true');
    act(() => {
      useUIStore.setState({ darkMode: false });
    });
    await waitFor(() =>
      expect(screen.getByTestId('header-theme-toggle')).toHaveAttribute('aria-pressed', 'false')
    );
  });

  it('exposes an accessible name that adapts to the next action', () => {
    renderShell();
    // Light mode is active → label hints "switch to dark".
    expect(screen.getByTestId('header-theme-toggle')).toHaveAttribute(
      'aria-label',
      'darkMode.switchToDark'
    );
    fireEvent.click(screen.getByTestId('header-theme-toggle'));
    // Dark mode now active → label hints "switch to light".
    expect(screen.getByTestId('header-theme-toggle')).toHaveAttribute(
      'aria-label',
      'darkMode.switchToLight'
    );
  });

  it('places the theme toggle next to the notification bell', () => {
    renderShell();
    const toggle = screen.getByTestId('header-theme-toggle');
    const bell = screen.getByTestId('notification-bell-stub');
    // Both must share the same flex parent (the header toolbar).
    expect(toggle.parentElement).toBe(bell.parentElement);
  });
});
