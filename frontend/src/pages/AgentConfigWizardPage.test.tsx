import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AgentConfigWizardPage } from './AgentConfigWizardPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'agentConfig.statusTodo') return 'todo';
      if (key === 'agentConfig.statusInProgress') return 'in_progress';
      if (key === 'agentConfig.statusReview') return 'review';
      if (key === 'agentConfig.statusDone') return 'done';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../hooks/useSetupGuard', () => ({ useSetupGuard: () => undefined }));

const { authApiMock } = vi.hoisted(() => ({
  authApiMock: { me: vi.fn() },
}));

vi.mock('../services/api', () => ({ authApi: authApiMock }));

const LocationDisplay = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
};

const renderPage = (entries: string[] = ['/onboarding/agent-config']) =>
  render(
    <MemoryRouter initialEntries={entries}>
      <AgentConfigWizardPage />
      <LocationDisplay />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  authApiMock.me.mockResolvedValue({ user: { id: 'u1' }, needsSetup: false });
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn() },
      configurable: true,
    });
  }
  (navigator.clipboard as { writeText: ReturnType<typeof vi.fn> }).writeText =
    vi.fn().mockResolvedValue(undefined);
});

describe('AgentConfigWizardPage (s-1245)', () => {
  it('renders the wizard sections by default', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('agent-config-token')).toBeInTheDocument();
    });
    expect(screen.getByTestId('agent-config-auth-cmd')).toHaveTextContent('kanban auth login');
    expect(screen.getByTestId('agent-config-generated')).toHaveTextContent('kanban run --mine');
  });

  it('generates a board-bound command when board mode is selected with a board id', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('agent-config-mode-board')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('agent-config-mode-board'));
    fireEvent.change(screen.getByTestId('agent-config-board-input'), {
      target: { value: 'sys' },
    });
    fireEvent.change(screen.getByTestId('agent-config-status-select'), {
      target: { value: 'in_progress' },
    });

    expect(screen.getByTestId('agent-config-generated')).toHaveTextContent(
      'kanban run --board sys --status in_progress',
    );
  });

  it('shows a friendly missing-board hint before a board id is supplied', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('agent-config-mode-board')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('agent-config-mode-board'));
    expect(screen.getByTestId('agent-config-missing-reason')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-config-generated')).not.toBeInTheDocument();
  });

  it('appends --bin when a binary is supplied', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('agent-config-bin-input')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('agent-config-bin-input'), {
      target: { value: 'claude' },
    });
    expect(screen.getByTestId('agent-config-generated')).toHaveTextContent('kanban run --mine --bin claude');
  });

  it('quotes a binary path that contains spaces', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('agent-config-bin-input')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('agent-config-bin-input'), {
      target: { value: '/Users/me/My Agent/binary' },
    });
    expect(screen.getByTestId('agent-config-generated')).toHaveTextContent(
      "kanban run --mine --bin '/Users/me/My Agent/binary'",
    );
  });

  it('copies the generated command when the copy button is clicked', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('agent-config-run-copy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('agent-config-run-copy'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('kanban run --mine');
    });
  });

  it('copies the auth login command independently', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('agent-config-auth-copy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('agent-config-auth-copy'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('kanban auth login');
    });
  });
});