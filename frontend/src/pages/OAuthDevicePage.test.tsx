import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { OAuthDevicePage } from './OAuthDevicePage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'oauth.device.title': 'Authorize device',
        'oauth.device.subtitle': 'Enter the code',
        'oauth.device.codeLabel': 'User code',
        'oauth.device.clientLabel': 'Application:',
        'oauth.device.scopeLabel': 'Requested permissions:',
        'oauth.device.approve': 'Approve',
        'oauth.device.deny': 'Deny',
        'oauth.device.unknownCode': 'Unknown code',
        'oauth.device.expired': 'Expired',
        'oauth.device.lookupFailed': 'Lookup failed',
        'oauth.device.failed': 'Failed',
        'oauth.device.loginRequired': 'Login required',
        'oauth.device.goLogin': 'Sign in',
        'oauth.device.approvedBanner': 'Approved. Return to device.',
        'oauth.device.deniedBanner': 'Denied.',
        'oauth.device.identityLabel': 'Authorize as',
        'oauth.device.identityAsSelf': 'Myself',
        'oauth.device.identityEmpty': 'No agents available',
        'oauth.device.identityRequired': 'Pick an identity first',
        'oauth.device.identityServerDefault': 'Server default'
      };
      return map[key] || key;
    },
    i18n: { language: 'en' }
  })
}));

vi.mock('../services/api', () => ({
  authApi: {
    me: vi.fn().mockResolvedValue({ user: { id: 'user-1' } })
  }
}));

const renderPage = (search = '') =>
  render(
    <MemoryRouter initialEntries={[`/oauth/device${search}`]}>
      <Routes>
        <Route path="/oauth/device" element={<OAuthDevicePage />} />
        <Route path="/login" element={<div>login-page-stub</div>} />
        <Route path="/setup" element={<div>setup-page-stub</div>} />
      </Routes>
    </MemoryRouter>
  );

describe('OAuthDevicePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders input from URL ?user_code query', () => {
    renderPage('?user_code=ABCD-1234');
    const input = screen.getByTestId('user-code-input') as HTMLInputElement;
    expect(input.value).toBe('ABCD-1234');
  });

  it('normalises input to upper-case', () => {
    renderPage();
    const input = screen.getByTestId('user-code-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abcd-1234' } });
    expect(input.value).toBe('ABCD-1234');
  });

  it('looks up metadata when code is typed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'kanban-client-1',
        clientName: 'open-kanban-mcp',
        scope: 'kanban:read tasks:write',
        expiresAt: new Date().toISOString(),
        status: 'pending'
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    const input = screen.getByTestId('user-code-input');
    fireEvent.change(input, { target: { value: 'ABCD-EFGH' } });

    await waitFor(() => {
      expect(screen.getByText(/open-kanban-mcp/)).toBeInTheDocument();
    });
    expect(screen.getByText(/kanban:read tasks:write/)).toBeInTheDocument();
  });

  it('shows error for unknown code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'NO-CODE1' } });

    await waitFor(() => {
      expect(screen.getByText('Unknown code')).toBeInTheDocument();
    });
  });

  it('shows error for expired code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 410, json: async () => ({}) }));
    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'EXPR-EXPR' } });

    await waitFor(() => {
      expect(screen.getByText('Expired')).toBeInTheDocument();
    });
  });

  it('disables buttons until a client is resolved', () => {
    renderPage();
    expect(screen.getByTestId('approve-btn')).toBeDisabled();
    expect(screen.getByTestId('deny-btn')).toBeDisabled();
  });

  it('submits approve decision and shows banner', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/oauth/device/lookup')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            clientId: 'kanban-client-1',
            clientName: 'open-kanban-mcp',
            scope: 'kanban:read',
            expiresAt: new Date().toISOString(),
            status: 'pending'
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ approved: true }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'ABCD-EFGH' } });
    await waitFor(() => expect(screen.getByTestId('approve-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('approve-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('decision-banner').textContent).toMatch(/Approved/);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/oauth/device/approve',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ user_code: 'ABCD-EFGH', decision: 'approve' })
      })
    );
  });

  it('redirects to login when API returns 401', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/oauth/device/lookup')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ clientId: 'c', clientName: 'C', scope: '', expiresAt: '', status: 'pending' })
        });
      }
      return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'AAAA-BBBB' } });
    await waitFor(() => expect(screen.getByTestId('approve-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('approve-btn'));

    await waitFor(() => {
      expect(screen.getByText('Sign in')).toBeInTheDocument();
    });
  });

  it('renders the identity picker when agentSelectionRequired=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'kanban-cli-1',
        clientName: 'open-kanban-cli',
        scope: 'kanban:read tasks:write',
        expiresAt: new Date().toISOString(),
        status: 'pending',
        agentSelectionRequired: true,
        availableAgents: [
          { id: 'agent-bot-1', nickname: 'Bot One', role: 'MEMBER' },
          { id: 'agent-bot-2', nickname: 'Bot Two', role: 'MEMBER' }
        ],
        defaultAgentId: 'agent-bot-1'
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'PICK-PICK' } });
    await waitFor(() => {
      expect(screen.getByTestId('identity-picker')).toBeInTheDocument();
    });
    expect(screen.getByTestId('identity-self')).toBeInTheDocument();
    expect(screen.getByTestId('identity-agent-agent-bot-1')).toBeInTheDocument();
    expect(screen.getByTestId('identity-agent-agent-bot-2')).toBeInTheDocument();
  });

  it('pre-selects the default agent from the lookup response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'kanban-cli-1',
        clientName: 'open-kanban-cli',
        scope: 'kanban:read',
        expiresAt: new Date().toISOString(),
        status: 'pending',
        agentSelectionRequired: true,
        availableAgents: [{ id: 'agent-bot-1', nickname: 'Bot One', role: 'MEMBER' }],
        defaultAgentId: 'agent-bot-1'
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'PICK-PICK' } });
    await waitFor(() => {
      expect(screen.getByTestId('identity-picker')).toBeInTheDocument();
    });
    const agentRadio = screen.getByTestId('identity-agent-radio-agent-bot-1') as HTMLInputElement;
    expect(agentRadio.checked).toBe(true);
  });

  it('submits agent_id when an Agent is picked', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/oauth/device/lookup')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            clientId: 'kanban-cli-1',
            clientName: 'open-kanban-cli',
            scope: 'kanban:read',
            expiresAt: new Date().toISOString(),
            status: 'pending',
            agentSelectionRequired: true,
            availableAgents: [{ id: 'agent-bot-1', nickname: 'Bot One', role: 'MEMBER' }]
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ approved: true }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'PICK-PICK' } });
    await waitFor(() => {
      expect(screen.getByTestId('identity-picker')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('identity-agent-radio-agent-bot-1'));
    fireEvent.click(screen.getByTestId('approve-btn'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/oauth/device/approve',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({
            user_code: 'PICK-PICK',
            decision: 'approve',
            agent_id: 'agent-bot-1'
          })
        })
      );
    });
  });

  it('omits agent_id when the approver picks "Myself"', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/oauth/device/lookup')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            clientId: 'kanban-cli-1',
            clientName: 'open-kanban-cli',
            scope: 'kanban:read',
            expiresAt: new Date().toISOString(),
            status: 'pending',
            agentSelectionRequired: true,
            availableAgents: [{ id: 'agent-bot-1', nickname: 'Bot One', role: 'MEMBER' }]
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ approved: true }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'PICK-PICK' } });
    await waitFor(() => {
      expect(screen.getByTestId('identity-picker')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('identity-self'));
    fireEvent.click(screen.getByTestId('approve-btn'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/oauth/device/approve',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ user_code: 'PICK-PICK', decision: 'approve' })
        })
      );
    });
  });

  it('hides the picker when agentSelectionRequired is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'kanban-web-1',
        clientName: 'kanban-web',
        scope: 'kanban:read',
        expiresAt: new Date().toISOString(),
        status: 'pending'
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'WEBB-WEBB' } });
    await waitFor(() => {
      expect(screen.getByText('kanban-web')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('identity-picker')).not.toBeInTheDocument();
  });

  it('shows the empty-state hint when no Agents are available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'kanban-cli-1',
        clientName: 'open-kanban-cli',
        scope: 'kanban:read',
        expiresAt: new Date().toISOString(),
        status: 'pending',
        agentSelectionRequired: true,
        availableAgents: []
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'NOAG-NOAG' } });
    await waitFor(() => {
      expect(screen.getByTestId('identity-picker')).toBeInTheDocument();
    });
    expect(screen.getByText('No agents available')).toBeInTheDocument();
  });
});