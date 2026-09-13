import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.edit': 'Edit',
        'common.delete': 'Delete',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
        'common.loading': 'Loading…',
        'oauth.admin.loading': 'Loading…',
        'oauth.admin.providers.title': 'Identity providers',
        'oauth.admin.providers.subtitle': 'Manage external OAuth / OIDC providers.',
        'oauth.admin.providers.tabProviders': 'Providers',
        'oauth.admin.providers.add': 'Add provider',
        'oauth.admin.providers.edit': 'Edit provider',
        'oauth.admin.providers.empty': 'No identity providers configured.',
        'oauth.admin.providers.confirmDelete': 'Delete this provider?',
        'oauth.admin.providers.providerCreated': 'Provider created.',
        'oauth.admin.providers.providerUpdated': 'Provider saved.',
        'oauth.admin.providers.providerDeleted': 'Provider deleted.',
        'oauth.admin.providers.providerEnabled': 'Provider enabled.',
        'oauth.admin.providers.providerDisabled': 'Provider disabled.',
        'oauth.admin.providers.enable': 'Enable',
        'oauth.admin.providers.disable': 'Disable',
        'oauth.admin.providers.enabledBadge': 'Enabled',
        'oauth.admin.providers.disabledBadge': 'Disabled',
        'oauth.admin.providers.secretSet': 'Secret configured',
        'oauth.admin.providers.secretUnset': 'No secret',
        'oauth.admin.providers.secretSetHelp': 'A client secret is already stored. Enter a new value to overwrite.',
        'oauth.admin.providers.secretUnsetHelp': 'Public clients may leave this blank.',
        'oauth.admin.providers.secretWriteOnlyHelp': 'Stored secrets are encrypted at rest and cannot be retrieved again.',
        'oauth.admin.providers.fields.providerId': 'Provider ID',
        'oauth.admin.providers.fields.providerIdHelp': 'Lowercase slug.',
        'oauth.admin.providers.fields.name': 'Display name',
        'oauth.admin.providers.fields.nameHelp': 'Shown to end users.',
        'oauth.admin.providers.fields.type': 'Provider type',
        'oauth.admin.providers.fields.typeHelp': 'Built-in preset or generic OIDC.',
        'oauth.admin.providers.fields.clientId': 'Client ID',
        'oauth.admin.providers.fields.clientSecret': 'Client secret',
        'oauth.admin.providers.fields.scopes': 'Scopes',
        'oauth.admin.providers.fields.scopesHelp': 'Space-separated scopes.',
        'oauth.admin.providers.fields.authEndpoint': 'Authorization endpoint',
        'oauth.admin.providers.fields.tokenEndpoint': 'Token endpoint',
        'oauth.admin.providers.fields.userinfoEndpoint': 'Userinfo endpoint',
        'oauth.admin.providers.fields.issuer': 'Issuer URL',
        'oauth.admin.providers.fields.issuerRequiredForOidc': 'Issuer is required for OIDC providers.',
        'oauth.admin.providers.fields.extraConfig': 'Extra config (JSON)',
        'oauth.admin.providers.fields.extraConfigHelp': 'Optional JSON object.',
        'oauth.admin.providers.fields.position': 'Order',
        'oauth.admin.providers.typeLabels.google': 'Google',
        'oauth.admin.providers.typeLabels.github': 'GitHub',
        'oauth.admin.providers.typeLabels.wecom': 'WeCom',
        'oauth.admin.providers.typeLabels.feishu': 'Feishu',
        'oauth.admin.providers.typeLabels.dingtalk': 'DingTalk',
        'oauth.admin.providers.typeLabels.oidc': 'Generic OIDC',
        'oauth.admin.providers.errors.providerIdFormat': 'Provider ID must be lowercase letters, digits, or dashes (3–64 chars).',
        'oauth.admin.providers.errors.nameRequired': 'Display name is required.',
        'oauth.admin.providers.errors.clientIdRequired': 'Client ID is required.',
        'oauth.admin.providers.errors.typeRequired': 'Provider type is required.',
        'oauth.admin.providers.errors.issuerRequired': 'Issuer URL is required for OIDC providers.',
        'oauth.admin.providers.errors.invalidUrl': 'Must be a valid http(s) URL.',
        'oauth.admin.providers.errors.invalidScopes': 'Scopes must be lowercase tokens separated by spaces.',
        'oauth.admin.providers.errors.invalidJson': 'Extra config must be valid JSON.'
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
  getOAuthProviders: vi.fn(),
  createOAuthProvider: vi.fn(),
  updateOAuthProvider: vi.fn(),
  deleteOAuthProvider: vi.fn()
};

vi.mock('../services/api', () => ({ authApi: apiMock }));

import { OAuthProvidersSettings } from './OAuthProvidersSettings';

const baseProviders = [
  {
    id: 'p-1',
    providerId: 'corp-okta',
    name: 'Corp Okta',
    type: 'oidc',
    enabled: true,
    position: 0,
    clientId: 'okta-client-id-123',
    secretSet: true,
    scopes: 'openid email profile',
    authEndpoint: 'https://okta.example.com/oauth2/v1/authorize',
    tokenEndpoint: 'https://okta.example.com/oauth2/v1/token',
    userinfoEndpoint: 'https://okta.example.com/oauth2/v1/userinfo',
    issuer: 'https://okta.example.com',
    extraConfig: '{}',
    createdBy: 'admin-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'p-2',
    providerId: 'google',
    name: 'Google',
    type: 'google',
    enabled: false,
    position: 1,
    clientId: 'google-client-id',
    secretSet: false,
    scopes: 'openid email',
    authEndpoint: '',
    tokenEndpoint: '',
    userinfoEndpoint: '',
    issuer: '',
    extraConfig: '{}',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z'
  }
];

describe('OAuthProvidersSettings', () => {
  beforeEach(() => {
    vi.resetModules();
    apiMock = {
      getOAuthProviders: vi.fn().mockResolvedValue(baseProviders),
      createOAuthProvider: vi.fn(),
      updateOAuthProvider: vi.fn(),
      deleteOAuthProvider: vi.fn()
    };
    vi.doMock('../services/api', () => ({ authApi: apiMock }));
    window.confirm = vi.fn(() => true);
  });

  it('renders the providers list for admins', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => {
      expect(screen.getByTestId('oauth-providers-settings')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('oauth-provider-row')).toHaveLength(2);
    expect(screen.getByText('Corp Okta')).toBeInTheDocument();
  });

  it('shows enabled/disabled badges and secret set/unset state', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => {
      expect(screen.getAllByTestId('oauth-provider-row')).toHaveLength(2);
    });
    const statuses = screen.getAllByTestId('oauth-provider-status');
    expect(statuses[0]).toHaveTextContent('Enabled');
    expect(statuses[1]).toHaveTextContent('Disabled');
    const secretStatuses = screen.getAllByTestId('oauth-provider-secret-status');
    expect(secretStatuses[0]).toHaveTextContent('Secret configured');
    expect(secretStatuses[1]).toHaveTextContent('No secret');
  });

  it('shows empty state when no providers exist', async () => {
    apiMock.getOAuthProviders.mockResolvedValue([]);
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => {
      expect(screen.getByText('No identity providers configured.')).toBeInTheDocument();
    });
  });

  it('toggles a provider enabled/disabled on switch click', async () => {
    apiMock.updateOAuthProvider.mockResolvedValue({ ...baseProviders[0], enabled: false });
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => expect(screen.getAllByTestId('oauth-provider-row')).toHaveLength(2));
    const toggle = screen.getAllByTestId('oauth-provider-toggle')[0];
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(apiMock.updateOAuthProvider).toHaveBeenCalledWith('p-1', { enabled: false });
    });
  });

  it('opens the create form when clicking Add provider', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('oauth-provider-add')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('oauth-provider-add'));
    expect(screen.getByTestId('oauth-provider-form')).toBeInTheDocument();
    expect(screen.getByTestId('oauth-provider-field-providerId')).not.toBeDisabled();
  });

  it('opens the edit form prefilled and disables providerId when editing', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => expect(screen.getAllByTestId('oauth-provider-row')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('oauth-provider-edit')[0]);
    const input = screen.getByTestId('oauth-provider-field-providerId') as HTMLInputElement;
    expect(input.value).toBe('corp-okta');
    expect(input.disabled).toBe(true);
    expect((screen.getByTestId('oauth-provider-field-name') as HTMLInputElement).value).toBe('Corp Okta');
    expect((screen.getByTestId('oauth-provider-field-clientId') as HTMLInputElement).value).toBe('okta-client-id-123');
  });

  it('shows validation errors when creating without required fields', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('oauth-provider-add')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('oauth-provider-add'));
    const providerIdInput = screen.getByTestId('oauth-provider-field-providerId');
    fireEvent.change(providerIdInput, { target: { value: 'BAD ID' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-name'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientId'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    expect(await screen.findByText('Provider ID must be lowercase letters, digits, or dashes (3–64 chars).')).toBeInTheDocument();
    expect(screen.getByText('Display name is required.')).toBeInTheDocument();
    expect(screen.getByText('Client ID is required.')).toBeInTheDocument();
    expect(apiMock.createOAuthProvider).not.toHaveBeenCalled();
  });

  it('rejects invalid scope tokens before submitting', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    fireEvent.click(await screen.findByTestId('oauth-provider-add'));
    fireEvent.change(screen.getByTestId('oauth-provider-field-providerId'), { target: { value: 'corp-saml' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-name'), { target: { value: 'SAML' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientId'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-scopes'), { target: { value: 'openid INVALID' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    expect(await screen.findByText('Scopes must be lowercase tokens separated by spaces.')).toBeInTheDocument();
    expect(apiMock.createOAuthProvider).not.toHaveBeenCalled();
  });

  it('requires issuer when type is oidc on create', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    fireEvent.click(await screen.findByTestId('oauth-provider-add'));
    fireEvent.change(screen.getByTestId('oauth-provider-field-providerId'), { target: { value: 'corp-oidc' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-name'), { target: { value: 'Corp' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientId'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-issuer'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    expect(await screen.findByText('Issuer URL is required for OIDC providers.')).toBeInTheDocument();
    expect(apiMock.createOAuthProvider).not.toHaveBeenCalled();
  });

  it('creates a new provider with valid payload', async () => {
    apiMock.createOAuthProvider.mockResolvedValue({
      id: 'p-new',
      providerId: 'corp-okta',
      name: 'Corp Okta',
      type: 'oidc',
      enabled: true,
      position: 0,
      clientId: 'new-cid',
      secretSet: true,
      scopes: 'openid email',
      authEndpoint: '',
      tokenEndpoint: '',
      userinfoEndpoint: '',
      issuer: 'https://okta.example.com',
      extraConfig: '{}',
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z'
    });
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    fireEvent.click(await screen.findByTestId('oauth-provider-add'));
    fireEvent.change(screen.getByTestId('oauth-provider-field-providerId'), { target: { value: 'corp-okta' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-name'), { target: { value: 'Corp Okta' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientId'), { target: { value: 'new-cid' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientSecret'), { target: { value: 'top-secret' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-issuer'), { target: { value: 'https://okta.example.com' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-scopes'), { target: { value: 'openid email' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    await waitFor(() => {
      expect(apiMock.createOAuthProvider).toHaveBeenCalledTimes(1);
    });
    const payload = apiMock.createOAuthProvider.mock.calls[0][0];
    expect(payload.providerId).toBe('corp-okta');
    expect(payload.clientSecret).toBe('top-secret');
    expect(payload.issuer).toBe('https://okta.example.com');
    await waitFor(() => {
      expect(screen.queryByTestId('oauth-provider-form')).not.toBeInTheDocument();
    });
  });

  it('omits clientSecret on update when field is left blank', async () => {
    apiMock.updateOAuthProvider.mockResolvedValue({ ...baseProviders[0], name: 'Updated' });
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => expect(screen.getAllByTestId('oauth-provider-row')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('oauth-provider-edit')[0]);
    fireEvent.change(screen.getByTestId('oauth-provider-field-name'), { target: { value: 'Updated' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    await waitFor(() => {
      expect(apiMock.updateOAuthProvider).toHaveBeenCalledTimes(1);
    });
    const [id, payload] = apiMock.updateOAuthProvider.mock.calls[0];
    expect(id).toBe('p-1');
    expect(payload.name).toBe('Updated');
    expect(payload.clientSecret).toBeUndefined();
  });

  it('includes clientSecret on update when field is provided', async () => {
    apiMock.updateOAuthProvider.mockResolvedValue({ ...baseProviders[0], secretSet: true });
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => expect(screen.getAllByTestId('oauth-provider-row')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('oauth-provider-edit')[0]);
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientSecret'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    await waitFor(() => {
      expect(apiMock.updateOAuthProvider).toHaveBeenCalledTimes(1);
    });
    const [, payload] = apiMock.updateOAuthProvider.mock.calls[0];
    expect(payload.clientSecret).toBe('new-secret');
  });

  it('rejects invalid JSON in extra config', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    fireEvent.click(await screen.findByTestId('oauth-provider-add'));
    fireEvent.change(screen.getByTestId('oauth-provider-field-providerId'), { target: { value: 'corp-okta' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-name'), { target: { value: 'Corp' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientId'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-issuer'), { target: { value: 'https://x.example.com' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-extraConfig'), { target: { value: 'not-json' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    expect(await screen.findByText('Extra config must be valid JSON.')).toBeInTheDocument();
    expect(apiMock.createOAuthProvider).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) endpoint URLs', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    fireEvent.click(await screen.findByTestId('oauth-provider-add'));
    fireEvent.change(screen.getByTestId('oauth-provider-field-providerId'), { target: { value: 'corp-okta' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-name'), { target: { value: 'Corp' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientId'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-issuer'), { target: { value: 'https://x.example.com' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-authEndpoint'), { target: { value: 'ftp://example.com' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    expect(await screen.findByText('Must be a valid http(s) URL.')).toBeInTheDocument();
    expect(apiMock.createOAuthProvider).not.toHaveBeenCalled();
  });

  it('allows http://localhost endpoints', async () => {
    apiMock.createOAuthProvider.mockResolvedValue({
      id: 'p-new',
      providerId: 'corp-local',
      name: 'Corp Local',
      type: 'oidc',
      enabled: true,
      position: 0,
      clientId: 'cid',
      secretSet: false,
      scopes: '',
      authEndpoint: 'http://localhost:9000/auth',
      tokenEndpoint: 'http://localhost:9000/token',
      userinfoEndpoint: '',
      issuer: 'http://localhost:9000',
      extraConfig: '{}',
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z'
    });
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    fireEvent.click(await screen.findByTestId('oauth-provider-add'));
    fireEvent.change(screen.getByTestId('oauth-provider-field-providerId'), { target: { value: 'corp-local' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-name'), { target: { value: 'Corp Local' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-clientId'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-issuer'), { target: { value: 'http://localhost:9000' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-authEndpoint'), { target: { value: 'http://localhost:9000/auth' } });
    fireEvent.change(screen.getByTestId('oauth-provider-field-tokenEndpoint'), { target: { value: 'http://localhost:9000/token' } });
    fireEvent.click(screen.getByTestId('oauth-provider-save'));
    await waitFor(() => {
      expect(apiMock.createOAuthProvider).toHaveBeenCalledTimes(1);
    });
  });

  it('cancels the form on Cancel button click', async () => {
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    fireEvent.click(await screen.findByTestId('oauth-provider-add'));
    expect(screen.getByTestId('oauth-provider-form')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('oauth-provider-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('oauth-provider-form')).not.toBeInTheDocument();
    });
  });

  it('deletes a provider after confirm', async () => {
    apiMock.deleteOAuthProvider.mockResolvedValue({ deleted: 'p-2' });
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => expect(screen.getAllByTestId('oauth-provider-row')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('oauth-provider-delete')[1]);
    await waitFor(() => {
      expect(apiMock.deleteOAuthProvider).toHaveBeenCalledWith('p-2');
    });
  });

  it('shows an inline error when listing fails', async () => {
    apiMock.getOAuthProviders.mockRejectedValue(new Error('boom'));
    const { OAuthProvidersSettings: Comp } = await import('./OAuthProvidersSettings');
    render(<Comp />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom');
    });
  });
});
