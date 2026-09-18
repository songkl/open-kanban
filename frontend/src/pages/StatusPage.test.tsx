import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    statusApi: {
      get: vi.fn(),
    },
  },
}));

vi.mock('../services/api', () => apiMock);

import { StatusPage } from './StatusPage';
import * as apiModule from '../services/api';

const mockedStatusGet = (apiModule.statusApi.get as unknown) as ReturnType<typeof vi.fn>;

function renderStatus(initialPath = '/status') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/status" element={<StatusPage />} />
        <Route path="/" element={<div data-testid="home-stub" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('StatusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use real timers but tighten the polling interval via the
    // component contract: setInterval is 30s and we don't want
    // the test to wait that long. We just don't let the test
    // run long enough for a second poll.
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the rich payload when /api/v1/status returns ok', async () => {
    mockedStatusGet.mockResolvedValueOnce({
      status: 'ok',
      timestamp: '2026-09-17T10:00:00Z',
      version: '0.16.0',
      uptimeSeconds: 7200,
      database: { type: 'sqlite', version: '3.45.0', reachable: true },
      migration: { lastVersion: '0.16.0', lastAppliedAt: '2026-09-17 09:30:00' },
      counts: { tasks: 42, activities: 1234, activitiesLast24h: 12 },
      agents: { total: 3, active: 2 },
      webhook: { enabled: true, urlConfigured: true, recentFailures: 0 },
    });

    renderStatus();

    expect(await screen.findByTestId('status-page')).toBeInTheDocument();
    expect(await screen.findByTestId('status-badge')).toHaveTextContent('statusPage.healthy');
    expect(screen.getByTestId('status-card-db')).toHaveTextContent('sqlite 3.45.0');
    expect(screen.getByTestId('status-card-migration')).toHaveTextContent('0.16.0');
    expect(screen.getByTestId('status-card-tasks')).toHaveTextContent('42');
    expect(screen.getByTestId('status-card-runs')).toHaveTextContent('1234');
    expect(screen.getByTestId('status-card-agents-total')).toHaveTextContent('3');
    expect(screen.getByTestId('status-card-agents-active')).toHaveTextContent('2');
    expect(screen.getByTestId('status-card-webhook-state')).toHaveTextContent('statusPage.webhookEnabled');
    expect(screen.getByTestId('status-card-webhook-failures')).toHaveTextContent('0');
  });

  it('renders degraded state when the API reports degraded', async () => {
    mockedStatusGet.mockResolvedValueOnce({
      status: 'degraded',
      timestamp: '2026-09-17T10:00:00Z',
      version: '0.16.0',
      uptimeSeconds: 600,
      database: { type: 'sqlite', version: '3.45.0', reachable: true },
      migration: { lastVersion: '0.16.0', lastAppliedAt: '2026-09-17 09:30:00' },
      counts: { tasks: 1, activities: 2, activitiesLast24h: 0 },
      agents: { total: 0, active: 0 },
      webhook: { enabled: true, urlConfigured: true, recentFailures: 5, lastFailureAt: '2026-09-17 09:55:00' },
    });

    renderStatus();

    expect(await screen.findByTestId('status-badge')).toHaveTextContent('statusPage.degraded');
    expect(screen.getByTestId('status-card-webhook-failures')).toHaveTextContent('5');
  });

  it('renders the error fallback when the API rejects', async () => {
    mockedStatusGet.mockRejectedValueOnce(new Error('Network unreachable'));

    renderStatus();

    await waitFor(() => {
      expect(screen.getByTestId('status-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('status-badge')).toHaveTextContent('statusPage.unhealthy');
    expect(screen.getByTestId('status-error')).toHaveTextContent('Network unreachable');
  });

  it('marks the database card as danger when unreachable', async () => {
    mockedStatusGet.mockResolvedValueOnce({
      status: 'degraded',
      timestamp: '2026-09-17T10:00:00Z',
      version: '0.16.0',
      uptimeSeconds: 60,
      database: { type: 'mysql', version: '', reachable: false },
      migration: { lastVersion: '', lastAppliedAt: '' },
      counts: { tasks: 0, activities: 0, activitiesLast24h: 0 },
      agents: { total: 0, active: 0 },
      webhook: { enabled: false, urlConfigured: false, recentFailures: 0 },
    });

    renderStatus();

    expect(await screen.findByTestId('status-page')).toBeInTheDocument();
    const dbCard = screen.getByTestId('status-card-db');
    expect(dbCard).toHaveTextContent('mysql');
    expect(dbCard).toHaveTextContent('statusPage.dbUnreachable');
  });

  it('renders no-migration copy when lastVersion is empty', async () => {
    mockedStatusGet.mockResolvedValueOnce({
      status: 'ok',
      timestamp: '2026-09-17T10:00:00Z',
      version: 'dev',
      uptimeSeconds: 30,
      database: { type: 'sqlite', version: '3.45.0', reachable: true },
      migration: { lastVersion: '', lastAppliedAt: '' },
      counts: { tasks: 0, activities: 0, activitiesLast24h: 0 },
      agents: { total: 0, active: 0 },
      webhook: { enabled: false, urlConfigured: false, recentFailures: 0 },
    });

    renderStatus();

    expect(await screen.findByTestId('status-page')).toBeInTheDocument();
    expect(screen.getByTestId('status-card-migration')).toHaveTextContent('statusPage.noMigration');
  });

  it('exposes a working back-home link to /', async () => {
    mockedStatusGet.mockResolvedValueOnce({
      status: 'ok',
      timestamp: '2026-09-17T10:00:00Z',
      version: '0.16.0',
      uptimeSeconds: 1,
      database: { type: 'sqlite', version: '3.45.0', reachable: true },
      migration: { lastVersion: '0.16.0', lastAppliedAt: '2026-09-17 09:30:00' },
      counts: { tasks: 0, activities: 0, activitiesLast24h: 0 },
      agents: { total: 0, active: 0 },
      webhook: { enabled: false, urlConfigured: false, recentFailures: 0 },
    });

    renderStatus();

    const backLink = await screen.findByText('statusPage.backHome');
    expect(backLink.closest('a')).toHaveAttribute('href', '/');
  });
});
