import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' }
  })
}));

// Mocked t() returns the key when there's no fallback, so use the
// raw i18n keys for placeholder/button lookups (matches what the
// source code passes to t() with no fallback argument).
const AGENT_NAME_PLACEHOLDER = 'settings.agentNamePlaceholder';
const CREATE_AGENT_BUTTON = 'settings.createAgent';

const { authApiMock, attachmentsApiMock, boardsApiMock } = vi.hoisted(() => ({
  authApiMock: {
    getAgents: vi.fn(),
    createAgent: vi.fn(),
    deleteAgent: vi.fn(),
    resetAgentToken: vi.fn(),
    setUserEnabled: vi.fn(),
    updateUser: vi.fn()
  },
  attachmentsApiMock: {
    upload: vi.fn()
  },
  boardsApiMock: {
    getAll: vi.fn()
  }
}));

vi.mock('../../services/api', () => ({
  authApi: authApiMock,
  attachmentsApi: attachmentsApiMock,
  boardsApi: boardsApiMock
}));

vi.mock('../UserAvatar', () => ({
  UserAvatar: ({ username }: { username: string }) => <div data-testid="avatar">{username}</div>
}));

vi.mock('../ConfirmDialog', () => ({
  ConfirmDialog: () => null
}));

vi.mock('../ErrorToast', () => ({
  showErrorToast: vi.fn()
}));

import { AgentsSettings } from './AgentsSettings';

const sampleAgent = {
  id: 'agent-1',
  nickname: 'mcp-bot',
  avatar: '🤖',
  type: 'AGENT',
  role: 'ADMIN',
  enabled: true,
  createdAt: new Date().toISOString(),
  tokenCount: 1,
  runsLast24h: 0,
  failsLast24h: 0,
  totalRuns: 0
};

const sampleBoards = [
  { id: 'b1', name: 'Public board', isPublic: true },
  { id: 'b2', name: 'Private board', isPublic: false }
];

beforeEach(() => {
  authApiMock.getAgents.mockReset();
  authApiMock.createAgent.mockReset();
  authApiMock.deleteAgent.mockReset();
  authApiMock.resetAgentToken.mockReset();
  authApiMock.setUserEnabled.mockReset();
  authApiMock.updateUser.mockReset();
  attachmentsApiMock.upload.mockReset();
  boardsApiMock.getAll.mockReset();

  authApiMock.getAgents.mockResolvedValue([sampleAgent]);
  authApiMock.createAgent.mockResolvedValue({
    agent: { ...sampleAgent, token: 'agent-token-xyz' }
  });
  boardsApiMock.getAll.mockResolvedValue(sampleBoards);
});

describe('AgentsSettings — board access picker (s-1253)', () => {
  it('renders one access picker per available board', async () => {
    render(<AgentsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-board-grants')).toBeInTheDocument();
    });
    expect(screen.getByTestId('agent-board-access-b1')).toBeInTheDocument();
    expect(screen.getByTestId('agent-board-access-b2')).toBeInTheDocument();
  });

  it('omits boardGrants when no access is picked on any board', async () => {
    render(<AgentsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-board-grants')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(AGENT_NAME_PLACEHOLDER), { target: { value: 'bot' } });
    fireEvent.click(screen.getByRole('button', { name: CREATE_AGENT_BUTTON }));

    await waitFor(() => {
      expect(authApiMock.createAgent).toHaveBeenCalledTimes(1);
    });
    const [, , , boardGrants] = authApiMock.createAgent.mock.calls[0];
    expect(boardGrants).toEqual([]);
  });

  it('sends explicit boardGrants matching the access chosen on each board', async () => {
    render(<AgentsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-board-grants')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(AGENT_NAME_PLACEHOLDER), { target: { value: 'scoped-bot' } });
    fireEvent.change(screen.getByTestId('agent-board-access-b1'), { target: { value: 'READ' } });
    fireEvent.change(screen.getByTestId('agent-board-access-b2'), { target: { value: 'ADMIN' } });
    fireEvent.click(screen.getByRole('button', { name: CREATE_AGENT_BUTTON }));

    await waitFor(() => {
      expect(authApiMock.createAgent).toHaveBeenCalledTimes(1);
    });
    const [, , , boardGrants] = authApiMock.createAgent.mock.calls[0];
    expect(boardGrants).toEqual(
      expect.arrayContaining([
        { boardId: 'b1', access: 'READ' },
        { boardId: 'b2', access: 'ADMIN' }
      ])
    );
  });

  it('drops a board from boardGrants when set back to "No access"', async () => {
    render(<AgentsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-board-grants')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(AGENT_NAME_PLACEHOLDER), { target: { value: 'scoped-bot' } });
    const b1Select = screen.getByTestId('agent-board-access-b1') as HTMLSelectElement;
    fireEvent.change(b1Select, { target: { value: 'WRITE' } });
    fireEvent.change(b1Select, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: CREATE_AGENT_BUTTON }));

    await waitFor(() => {
      expect(authApiMock.createAgent).toHaveBeenCalledTimes(1);
    });
    const [, , , boardGrants] = authApiMock.createAgent.mock.calls[0];
    expect(boardGrants).toEqual([]);
  });
});