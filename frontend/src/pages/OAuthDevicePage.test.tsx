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
        'oauth.device.disabledTitle': 'Device authorization is disabled',
        'oauth.device.disabledBody': 'An administrator has turned off the OAuth device flow.',
        'oauth.device.identitySectionTitle': 'Authorize as',
        'oauth.device.identityHelper': 'Pick the identity the device should receive access for.',
        'oauth.device.identitySelf': 'Myself ({{name}})',
        'oauth.device.identityYouFallback': 'you',
        'oauth.device.identityAgent': 'Agent: {{name}}',
        'oauth.device.identityServerDefault': 'Server default',
        'oauth.device.identityEmpty': 'No Agent accounts are available. Ask an administrator to enable one before approving a device.',
        'oauth.device.identityConfirmSelf': 'Authorise as yourself?',
        'oauth.device.identityConfirmAgent': 'Authorise as an Agent?',
        'oauth.device.identityConfirmSummary': '{{client}} will receive access on behalf of {{identity}}.',
        'oauth.device.identityConfirmSelfCta': 'Yes, authorise as me',
        'oauth.device.identityConfirmAgentCta': 'Yes, authorise as this Agent',
        'oauth.device.identityConfirmCancel': 'Pick a different identity'
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

  it('renders input from URL ?code query', () => {
    renderPage('?code=ABCD-1234');
    const input = screen.getByTestId('user-code-input') as HTMLInputElement;
    expect(input.value).toBe('ABCD-1234');
  });

  it('falls back to ?user_code when ?code is missing', () => {
    renderPage('?user_code=ABCD-1234');
    const input = screen.getByTestId('user-code-input') as HTMLInputElement;
    expect(input.value).toBe('ABCD-1234');
  });

  it('prefers ?code over ?user_code when both are present', () => {
    renderPage('?code=WINN-WINN&user_code=AAAA-1111');
    const input = screen.getByTestId('user-code-input') as HTMLInputElement;
    expect(input.value).toBe('WINN-WINN');
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
    // s-1131: first click opens the confirmation banner, second
    // click submits. Both are exercised so the legacy
    // "approve as myself" path stays covered by the existing
    // happy-path test.
    fireEvent.click(screen.getByTestId('approve-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('identity-confirm-approve')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('identity-confirm-approve'));

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
    // s-1131: the approval request only fires after the user
    // confirms in the banner; first click opens the banner, second
    // click submits.
    fireEvent.click(screen.getByTestId('approve-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('identity-confirm-approve')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('identity-confirm-approve'));

    await waitFor(() => {
      expect(screen.getByText('Sign in')).toBeInTheDocument();
    });
  });

  it('shows the disabled notice when lookup returns 503 oauth_device_disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'oauth_device_disabled' })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage('?code=DSBL-DSBL');
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'DSBL-DSBL' } });

    await waitFor(() => {
      expect(screen.getByTestId('device-disabled-card')).toBeInTheDocument();
    });
    expect(screen.getByText('Device authorization is disabled')).toBeInTheDocument();
  });

  it('renders the identity picker when the lookup returns one or more agents', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'kanban-client-1',
        clientName: 'open-kanban-mcp',
        scope: 'kanban:read',
        expiresAt: new Date().toISOString(),
        status: 'pending',
        agents: [
          { id: 'agent-alpha', nickname: 'Alpha', username: 'alpha-bot', role: 'agent' },
          { id: 'agent-beta', nickname: 'Beta', username: 'beta-bot', role: 'agent' }
        ]
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'AGNT-AGNT' } });

    await waitFor(() => {
      expect(screen.getByTestId('identity-picker')).toBeInTheDocument();
    });
    expect(screen.getByTestId('identity-self')).toBeInTheDocument();
    expect(screen.getByTestId('identity-agent-agent-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('identity-agent-agent-beta')).toBeInTheDocument();
  });

  it('keeps Approve disabled until a client is resolved and enables it once agents are listed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: 'kanban:read',
        expiresAt: '',
        status: 'pending',
        agents: [{ id: 'agent-alpha', nickname: 'Alpha' }]
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    expect(screen.getByTestId('approve-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'WAIT-WAIT' } });

    await waitFor(() => {
      expect(screen.getByTestId('identity-picker')).toBeInTheDocument();
    });
    expect(screen.getByTestId('approve-btn')).not.toBeDisabled();
  });

  it('submits the selected agentId when the user authorises an Agent', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/oauth/device/lookup')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            clientId: 'c',
            clientName: 'C',
            scope: 'kanban:read',
            expiresAt: '',
            status: 'pending',
            agents: [{ id: 'agent-alpha', nickname: 'Alpha' }]
          })
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ approved: true, boundTo: 'agent-alpha' })
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'PICK-PICK' } });
    await waitFor(() =>
      expect(screen.getByTestId('identity-agent-agent-alpha')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('identity-agent-agent-alpha'));
    await waitFor(() => expect(screen.getByTestId('approve-btn')).not.toBeDisabled());
    // s-1131: clicking Approve opens the confirmation banner; the
    // network request only fires after the user clicks "Confirm" in
    // the banner. We assert both halves of that flow.
    fireEvent.click(screen.getByTestId('approve-btn'));
    expect(screen.getByTestId('identity-confirm-banner')).toBeInTheDocument();
    // The first approve click MUST NOT have hit /oauth/device/approve yet.
    const approveCallsBefore = fetchMock.mock.calls.filter(([u]) =>
      typeof u === 'string' && u.startsWith('/oauth/device/approve')
    );
    expect(approveCallsBefore.length).toBe(0);
    fireEvent.click(screen.getByTestId('identity-confirm-approve'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/oauth/device/approve',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({
            user_code: 'PICK-PICK',
            decision: 'approve',
            agentId: 'agent-alpha'
          })
        })
      );
    });
  });

  it('submits an empty agentId when the user authorises as themselves', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/oauth/device/lookup')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            clientId: 'c',
            clientName: 'C',
            scope: 'kanban:read',
            expiresAt: '',
            status: 'pending',
            agents: [{ id: 'agent-alpha', nickname: 'Alpha' }]
          })
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ approved: true })
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'SELF-SELF' } });
    await waitFor(() => expect(screen.getByTestId('identity-self')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('approve-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('approve-btn'));
    // s-1131: confirmation banner appears; legacy "Myself" path
    // takes the same route so the approver can read the
    // identitySummary line.
    expect(screen.getByTestId('identity-confirm-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('identity-confirm-approve'));

    await waitFor(() => {
      const approveCall = fetchMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/oauth/device/approve')
      );
      expect(approveCall).toBeDefined();
      const body = JSON.parse((approveCall as [string, RequestInit])[1].body as string);
      expect(body.user_code).toBe('SELF-SELF');
      expect(body.decision).toBe('approve');
      expect(body).not.toHaveProperty('agentId');
    });
  });

  it('hides the identity picker when the lookup returns an empty agent list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: 'kanban:read',
        expiresAt: '',
        status: 'pending',
        agents: []
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'NONE-NONE' } });

    await waitFor(() => {
      expect(screen.getByTestId('approve-btn')).not.toBeDisabled();
    });
    expect(screen.queryByTestId('identity-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identity-self')).not.toBeInTheDocument();
  });

  it('hides the identity picker when the lookup omits the agents field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: '',
        expiresAt: '',
        status: 'pending'
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'MISS-MISS' } });

    await waitFor(() => {
      expect(screen.getByTestId('approve-btn')).not.toBeDisabled();
    });
    expect(screen.queryByTestId('identity-picker')).not.toBeInTheDocument();
  });

  it('pre-selects the server-suggested defaultAgentId when it matches an agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: 'kanban:read',
        expiresAt: '',
        status: 'pending',
        defaultAgentId: 'agent-beta',
        agents: [
          { id: 'agent-alpha', nickname: 'Alpha' },
          { id: 'agent-beta', nickname: 'Beta' }
        ]
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'DFFT-DFFT' } });

    await waitFor(() =>
      expect(screen.getByTestId('identity-agent-agent-beta')).toBeInTheDocument()
    );
    const betaRadio = screen.getByTestId('identity-agent-agent-beta') as HTMLInputElement;
    const alphaRadio = screen.getByTestId('identity-agent-agent-alpha') as HTMLInputElement;
    const selfRadio = screen.getByTestId('identity-self') as HTMLInputElement;
    expect(betaRadio.checked).toBe(true);
    expect(alphaRadio.checked).toBe(false);
    expect(selfRadio.checked).toBe(false);
  });

  it('ignores defaultAgentId when it does not match any agent and falls back to Myself', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: '',
        expiresAt: '',
        status: 'pending',
        defaultAgentId: 'ghost-agent',
        agents: [{ id: 'agent-alpha', nickname: 'Alpha' }]
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'GHST-GHST' } });

    await waitFor(() =>
      expect(screen.getByTestId('identity-agent-agent-alpha')).toBeInTheDocument()
    );
    const selfRadio = screen.getByTestId('identity-self') as HTMLInputElement;
    const alphaRadio = screen.getByTestId('identity-agent-agent-alpha') as HTMLInputElement;
    expect(selfRadio.checked).toBe(true);
    expect(alphaRadio.checked).toBe(false);
  });

  it('shows a Server default badge on the agent that matches defaultAgentId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: 'kanban:read',
        expiresAt: '',
        status: 'pending',
        defaultAgentId: 'agent-beta',
        agents: [
          { id: 'agent-alpha', nickname: 'Alpha' },
          { id: 'agent-beta', nickname: 'Beta' }
        ]
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'BADG-BADG' } });

    await waitFor(() =>
      expect(screen.getByTestId('identity-agent-agent-beta-default-badge')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('identity-agent-agent-alpha-default-badge')).not.toBeInTheDocument();
    expect(screen.getByTestId('identity-agent-agent-beta-default-badge').textContent).toMatch(
      /Server default/
    );
  });

  it('does not render a Server default badge when defaultAgentId does not match an agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: '',
        expiresAt: '',
        status: 'pending',
        defaultAgentId: 'ghost-agent',
        agents: [
          { id: 'agent-alpha', nickname: 'Alpha' },
          { id: 'agent-beta', nickname: 'Beta' }
        ]
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'NBAD-NBAD' } });

    await waitFor(() =>
      expect(screen.getByTestId('identity-agent-agent-beta')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('identity-agent-agent-alpha-default-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identity-agent-agent-beta-default-badge')).not.toBeInTheDocument();
  });

  it('renders the empty-state and disables Approve when agent_selection_required is true and no agents are available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: 'kanban:read',
        expiresAt: '',
        status: 'pending',
        agentSelectionRequired: true,
        agents: []
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'EMPT-EMPT' } });

    await waitFor(() => {
      expect(screen.getByTestId('identity-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('identity-empty').textContent).toMatch(/No Agent accounts/i);
    expect(screen.queryByTestId('identity-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identity-self')).not.toBeInTheDocument();
    expect(screen.getByTestId('approve-btn')).toBeDisabled();
    expect(screen.getByTestId('deny-btn')).not.toBeDisabled();
  });

  it('hides the empty-state and keeps Approve enabled when agents is empty but agent_selection_required is not set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'c',
        clientName: 'C',
        scope: 'kanban:read',
        expiresAt: '',
        status: 'pending',
        agents: []
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'LEGC-LEGC' } });

    await waitFor(() => {
      expect(screen.getByTestId('approve-btn')).not.toBeDisabled();
    });
    expect(screen.queryByTestId('identity-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identity-picker')).not.toBeInTheDocument();
  });

  it('opens a confirmation banner when Approve is clicked and only submits after Confirm', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/oauth/device/lookup')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            clientId: 'kanban-client-1',
            clientName: 'open-kanban-cli',
            scope: 'kanban:read tasks:write',
            expiresAt: new Date().toISOString(),
            status: 'pending',
            agents: [{ id: 'agent-alpha', nickname: 'Alpha', role: 'AGENT' }]
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ approved: true, boundTo: 'agent-alpha' }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'CONF-CONF' } });
    await waitFor(() =>
      expect(screen.getByTestId('identity-agent-agent-alpha')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('identity-agent-agent-alpha'));
    fireEvent.click(screen.getByTestId('approve-btn'));

    // Banner visible, no network call yet.
    expect(screen.getByTestId('identity-confirm-banner')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([u]) =>
        typeof u === 'string' && u.startsWith('/oauth/device/approve')
      ).length
    ).toBe(0);

    // Confirm — now the request fires.
    fireEvent.click(screen.getByTestId('identity-confirm-approve'));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([u]) =>
          typeof u === 'string' && u.startsWith('/oauth/device/approve')
        ).length
      ).toBe(1);
    });
  });

  it('cancels out of the confirmation banner without sending the approve', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/oauth/device/lookup')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            clientId: 'c',
            clientName: 'C',
            scope: 'kanban:read',
            expiresAt: '',
            status: 'pending',
            agents: [{ id: 'agent-alpha', nickname: 'Alpha' }]
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ approved: true }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'BACK-BACK' } });
    await waitFor(() =>
      expect(screen.getByTestId('identity-agent-agent-alpha')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('identity-agent-agent-alpha'));
    fireEvent.click(screen.getByTestId('approve-btn'));
    expect(screen.getByTestId('identity-confirm-banner')).toBeInTheDocument();

    // Cancel: pick a different identity, banner disappears, no network call.
    fireEvent.click(screen.getByTestId('identity-confirm-cancel'));
    expect(screen.queryByTestId('identity-confirm-banner')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([u]) =>
        typeof u === 'string' && u.startsWith('/oauth/device/approve')
      ).length
    ).toBe(0);

    // And the Approve button is re-enabled so the user can try again
    // with the new selection.
    expect(screen.getByTestId('approve-btn')).not.toBeDisabled();
  });

  it('renders the agent-aware confirmation copy when an Agent is selected', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        clientId: 'kanban-client-1',
        clientName: 'open-kanban-cli',
        scope: 'kanban:read tasks:write',
        expiresAt: new Date().toISOString(),
        status: 'pending',
        agents: [{ id: 'agent-alpha', nickname: 'Alpha' }]
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.change(screen.getByTestId('user-code-input'), { target: { value: 'AGNT-AGNT' } });
    await waitFor(() =>
      expect(screen.getByTestId('identity-agent-agent-alpha')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('identity-agent-agent-alpha'));
    fireEvent.click(screen.getByTestId('approve-btn'));

    expect(screen.getByText('Authorise as an Agent?')).toBeInTheDocument();
    // Approve-cta copy flips to the Agent-specific variant.
    expect(screen.getByTestId('identity-confirm-approve')).toHaveTextContent(/Agent/);
  });
});