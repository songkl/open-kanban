import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'login.welcome': 'Enter your username to get started',
        'login.username': 'Username',
        'login.enterNickname': 'Enter your nickname',
        'login.password': 'Password',
        'login.enterPassword': 'Set password (optional)',
        'login.loggingIn': 'Logging in...',
        'login.start': 'Get Started',
        'login.failed': 'Login failed, please try again',
        'login.external.signInWith': 'Sign in with {{provider}}',
        'login.external.or': 'or',
        'login.external.loadError': 'Could not load sign-in providers.',
        'login.external.callbackError': 'The sign-in link is invalid or has expired.',
        'login.external.missingEndpoint': 'This provider is not configured correctly.'
      };
      let value = map[key] || key;
      if (params && typeof value === 'string' && value.includes('{{')) {
        Object.entries(params).forEach(([k, v]) => {
          value = value.replace(`{{${k}}}`, String(v));
        });
      }
      return value;
    },
    i18n: { language: 'en' }
  })
}));

let apiMock = {
  me: vi.fn(),
  getEnabledExternalProviders: vi.fn(),
  completeExternalLogin: vi.fn()
};

const renderPage = (ui: React.ReactElement, search = '/login') =>
  render(
    <MemoryRouter initialEntries={[search]}>
      <Routes>
        <Route path="/login" element={ui} />
        <Route path="/board/:id" element={<div>board-stub</div>} />
        <Route path="/boards" element={<div>boards-list-stub</div>} />
        <Route path="/setup" element={<div>setup-page-stub</div>} />
      </Routes>
    </MemoryRouter>
  );

const resetLocation = () => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { origin: 'https://kanban.test', href: '' }
  });
};

describe('LoginPage', () => {
  beforeEach(() => {
    vi.resetModules();
    apiMock = {
      me: vi.fn().mockResolvedValue({ user: null, needsSetup: false }),
      getEnabledExternalProviders: vi.fn().mockResolvedValue([]),
      completeExternalLogin: vi.fn()
    };
    vi.doMock('../services/api', () => ({
      authApi: apiMock,
      boardsApi: {
        getAll: vi.fn().mockResolvedValue([{ id: 'board-1' }])
      }
    }));
    resetLocation();
  });

  it('does not render external-provider buttons when none are configured', async () => {
    apiMock.getEnabledExternalProviders.mockResolvedValue([]);
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />);
    await waitFor(() => {
      expect(apiMock.getEnabledExternalProviders).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('external-providers')).not.toBeInTheDocument();
  });

  it('renders one button per enabled provider sorted by position', async () => {
    apiMock.getEnabledExternalProviders.mockResolvedValue([
      {
        providerId: 'corp-okta',
        name: 'Corp Okta',
        type: 'oidc',
        position: 2,
        clientId: 'okta-cid',
        scopes: 'openid email',
        authEndpoint: 'https://okta.example.com/oauth2/v1/authorize'
      },
      {
        providerId: 'google',
        name: 'Google',
        type: 'google',
        position: 0,
        clientId: 'google-cid',
        scopes: 'openid email profile',
        authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth'
      },
      {
        providerId: 'github',
        name: 'GitHub',
        type: 'github',
        position: 1,
        clientId: 'gh-cid',
        scopes: 'user:email',
        authEndpoint: 'https://github.com/login/oauth/authorize'
      }
    ]);
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />);
    await waitFor(() => {
      expect(screen.getAllByTestId(/^external-provider-/)).toHaveLength(3);
    });
    // Order is position-ascending regardless of insertion order.
    const buttons = screen.getAllByTestId(/^external-provider-/) as HTMLButtonElement[];
    expect(buttons[0].getAttribute('data-testid')).toBe('external-provider-google');
    expect(buttons[1].getAttribute('data-testid')).toBe('external-provider-github');
    expect(buttons[2].getAttribute('data-testid')).toBe('external-provider-corp-okta');
    expect(buttons[0]).toHaveTextContent('Sign in with Google');
  });

  it('builds an authorize URL and redirects the browser when a provider button is clicked', async () => {
    apiMock.getEnabledExternalProviders.mockResolvedValue([
      {
        providerId: 'google',
        name: 'Google',
        type: 'google',
        position: 0,
        clientId: 'google-cid',
        scopes: 'openid email profile',
        authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth'
      }
    ]);
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />);
    await waitFor(() => expect(screen.getByTestId('external-provider-google')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('external-provider-google'));
    const href = (window.location as { href?: string }).href;
    expect(href).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(href).toContain('client_id=google-cid');
    expect(href).toContain('response_type=code');
    expect(href).toContain('scope=openid+email+profile');
    expect(href).toContain('redirect_uri=https%3A%2F%2Fkanban.test%2Flogin%3Fprovider%3Dgoogle');
    expect(href).toContain('state=');
  });

  it('shows an inline error when the provider has no authEndpoint configured', async () => {
    apiMock.getEnabledExternalProviders.mockResolvedValue([
      {
        providerId: 'broken',
        name: 'Broken',
        type: 'oidc',
        position: 0,
        clientId: 'cid',
        scopes: '',
        authEndpoint: ''
      }
    ]);
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />);
    await waitFor(() => expect(screen.getByTestId('external-provider-broken')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('external-provider-broken'));
    expect(screen.getByText('This provider is not configured correctly.')).toBeInTheDocument();
  });

  it('exchanges ?code with the callback endpoint and navigates to a board', async () => {
    apiMock.completeExternalLogin.mockResolvedValue({
      user: { id: 'u-1' },
      token: 'tok',
      binding: { provisioned: true, linked: false, bound: false },
      provider: { id: 'google', name: 'Google' }
    });
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />, '/login?code=abc123&provider=google&state=nonce');
    await waitFor(() => {
      expect(apiMock.completeExternalLogin).toHaveBeenCalledWith('google', {
        code: 'abc123',
        state: 'nonce'
      });
    });
    await waitFor(() => {
      expect(screen.getByText('board-stub')).toBeInTheDocument();
    });
  });

  it('surfaces a callback error when the server rejects the code', async () => {
    apiMock.completeExternalLogin.mockRejectedValue(new Error('code expired'));
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />, '/login?code=badcode&provider=google');
    await waitFor(() => {
      expect(screen.getByText('code expired')).toBeInTheDocument();
    });
  });

  it('surfaces the generic callback message when the error has no message', async () => {
    apiMock.completeExternalLogin.mockRejectedValue(new Error());
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />, '/login?code=badcode&provider=google');
    await waitFor(() => {
      expect(screen.getByText('The sign-in link is invalid or has expired.')).toBeInTheDocument();
    });
  });

  it('ignores a ?code URL when the provider slug is missing', async () => {
    apiMock.completeExternalLogin.mockResolvedValue({});
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />, '/login?code=lonely');
    await new Promise(r => setTimeout(r, 50));
    expect(apiMock.completeExternalLogin).not.toHaveBeenCalled();
  });

  it('surfaces a load error when the public listing endpoint fails', async () => {
    apiMock.getEnabledExternalProviders.mockRejectedValue(new Error('server boom'));
    const { LoginPage: Comp } = await import('./LoginPage');
    renderPage(<Comp />);
    await waitFor(() => {
      expect(screen.getByText('Could not load sign-in providers.')).toBeInTheDocument();
    });
  });
});