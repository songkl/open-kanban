import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentActivityPage, getAgentHealth, getAgentFailureRate } from './AgentActivityPage';
import type { Agent } from '../types/kanban';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params.count === 'number') {
        return `${params.count} ${key}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../hooks/useSetupGuard', () => ({ useSetupGuard: () => undefined }));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    authApi: {
      getAgents: vi.fn(),
      me: vi.fn().mockResolvedValue({ user: { id: 'admin1' }, needsSetup: false }),
    },
    activitiesApi: {
      getByAgent: vi.fn(),
    },
  },
}));

vi.mock('../services/api', () => ({
  authApi: apiMock.authApi,
  activitiesApi: apiMock.activitiesApi,
}));

const HEALTHY_AGENT: Agent = {
  id: 'agent-healthy',
  nickname: 'Healthy Bot',
  avatar: '🤖',
  type: 'AGENT',
  role: 'MEMBER',
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastActiveAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  tokenCount: 1,
  runsLast24h: 12,
  failsLast24h: 0,
  totalRuns: 240,
};

const WARNING_AGENT: Agent = {
  id: 'agent-warning',
  nickname: 'Warning Bot',
  avatar: '⚠️',
  type: 'AGENT',
  role: 'MEMBER',
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastActiveAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  tokenCount: 1,
  runsLast24h: 8,
  failsLast24h: 1,
  totalRuns: 90,
};

const UNHEALTHY_AGENT: Agent = {
  id: 'agent-unhealthy',
  nickname: 'Unhealthy Bot',
  avatar: '💀',
  type: 'AGENT',
  role: 'MEMBER',
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastActiveAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  tokenCount: 1,
  runsLast24h: 10,
  failsLast24h: 5,
  totalRuns: 200,
};

describe('AgentActivityPage health helpers (s-1209)', () => {
  it('classifies a fresh, failure-free agent as healthy', () => {
    expect(getAgentHealth(HEALTHY_AGENT)).toBe('healthy');
  });

  it('classifies an agent with a stale heartbeat as warning', () => {
    expect(getAgentHealth(WARNING_AGENT)).toBe('warning');
  });

  it('classifies an agent with a 5h-old heartbeat as unhealthy', () => {
    expect(getAgentHealth(UNHEALTHY_AGENT)).toBe('unhealthy');
  });

  it('returns unhealthy when an agent has no heartbeat at all', () => {
    const orphan: Agent = {
      ...HEALTHY_AGENT,
      id: 'agent-orphan',
      lastActiveAt: undefined,
      lastHeartbeatAt: undefined,
    };
    expect(getAgentHealth(orphan)).toBe('unhealthy');
  });

  it('computes failure rate as 0 for zero runs and rounds the percentage', () => {
    expect(getAgentFailureRate({ ...HEALTHY_AGENT, runsLast24h: 0 })).toBe(0);
    expect(getAgentFailureRate({ ...WARNING_AGENT, runsLast24h: 4, failsLast24h: 1 })).toBe(0.25);
  });

  it('treats missing 24h counters as zero (legacy agents without health data)', () => {
    const legacy: Agent = {
      ...HEALTHY_AGENT,
      runsLast24h: 0,
      failsLast24h: 0,
      totalRuns: 0,
    };
    expect(getAgentHealth(legacy)).toBe('healthy');
    expect(getAgentFailureRate(legacy)).toBe(0);
  });
});

describe('AgentActivityPage UI (s-1209)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the health badge and failure-rate column for each agent', async () => {
    apiMock.authApi.getAgents.mockResolvedValue([HEALTHY_AGENT, WARNING_AGENT, UNHEALTHY_AGENT]);
    apiMock.activitiesApi.getByAgent.mockResolvedValue({ activities: [], hasMore: false, total: 0 });

    render(
      <MemoryRouter>
        <AgentActivityPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(apiMock.authApi.getAgents).toHaveBeenCalled();
    });

    // Each agent list item must expose its health badge via
    // the data-testid hook so the test can scope lookups
    // without depending on the (translated) badge label.
    for (const a of [HEALTHY_AGENT, WARNING_AGENT, UNHEALTHY_AGENT]) {
      const item = await screen.findByTestId(`agent-list-item-${a.id}`);
      expect(item).toBeInTheDocument();
      // The failure-rate percentage text (e.g. "0%") must be
      // rendered somewhere in the row.
      const failurePct = `${Math.round(((a.failsLast24h ?? 0) / Math.max(1, a.runsLast24h ?? 0)) * 100)}%`;
      expect(within(item).getByText(failurePct)).toBeInTheDocument();
    }
  });

  it('shows the agent health detail panel after selecting an agent', async () => {
    apiMock.authApi.getAgents.mockResolvedValue([WARNING_AGENT]);
    apiMock.activitiesApi.getByAgent.mockResolvedValue({ activities: [], hasMore: false, total: 0 });

    render(
      <MemoryRouter>
        <AgentActivityPage />
      </MemoryRouter>,
    );

    const item = await screen.findByTestId(`agent-list-item-${WARNING_AGENT.id}`);
    fireEvent.click(item);

    const panel = await screen.findByTestId('agent-health-panel');
    expect(panel).toHaveTextContent('settings.agentActivity.health.warning');
    expect(panel).toHaveTextContent('settings.agentActivity.runsLast24h');
    expect(panel).toHaveTextContent('settings.agentActivity.failsLast24h');
    expect(panel).toHaveTextContent('settings.agentActivity.failureRate24h');
    expect(panel).toHaveTextContent('settings.agentActivity.totalRuns');
  });

  it('does not render the health detail panel when no agent is selected', async () => {
    apiMock.authApi.getAgents.mockResolvedValue([HEALTHY_AGENT]);
    apiMock.activitiesApi.getByAgent.mockResolvedValue({ activities: [], hasMore: false, total: 0 });

    render(
      <MemoryRouter>
        <AgentActivityPage />
      </MemoryRouter>,
    );

    await screen.findByTestId(`agent-list-item-${HEALTHY_AGENT.id}`);
    expect(screen.queryByTestId('agent-health-panel')).not.toBeInTheDocument();
  });
});
