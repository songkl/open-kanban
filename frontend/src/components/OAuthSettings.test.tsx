import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'oauth.admin.title': 'OAuth 2.1',
        'oauth.admin.subtitle': 'Manage applications that access your kanban.',
        'oauth.admin.tabClients': 'Apps',
        'oauth.admin.tabConsents': 'Permissions',
        'oauth.admin.tabConfig': 'Settings',
        'oauth.admin.loading': 'Loading…',
        'oauth.admin.noClients': 'No applications registered.',
        'oauth.admin.noConsents': 'No permissions granted.',
        'oauth.admin.revoke': 'Revoke',
        'oauth.admin.confirmDeleteClient': 'Delete this app?',
        'oauth.admin.confirmRevoke': 'Revoke permission?',
        'oauth.admin.clientDeleted': 'Application deleted.',
        'oauth.admin.consentRevoked': 'Permission revoked.',
        'oauth.admin.configSaved': 'Settings saved.',
        'oauth.admin.dynamicRegistration': 'Dynamic registration is {{enabled}}.',
        'common.delete': 'Delete',
        'common.save': 'Save'
      };
      let value = map[key] || key;
      if (params && value.includes('{{')) {
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
  getOAuthClients: vi.fn(),
  getOAuthConsents: vi.fn(),
  getOAuthConfig: vi.fn(),
  deleteOAuthClient: vi.fn(),
  revokeOAuthConsent: vi.fn(),
  updateOAuthConfig: vi.fn()
};

vi.mock('../services/api', () => ({ authApi: apiMock }));

import { OAuthSettings } from './OAuthSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'oauth.admin.title': 'OAuth 2.1',
        'oauth.admin.subtitle': 'Manage applications that access your kanban.',
        'oauth.admin.tabClients': 'Apps',
        'oauth.admin.tabConsents': 'Permissions',
        'oauth.admin.tabConfig': 'Settings',
        'oauth.admin.loading': 'Loading…',
        'oauth.admin.noClients': 'No applications registered.',
        'oauth.admin.noConsents': 'No permissions granted.',
        'oauth.admin.revoke': 'Revoke',
        'oauth.admin.confirmDeleteClient': 'Delete this app?',
        'oauth.admin.confirmRevoke': 'Revoke permission?',
        'oauth.admin.clientDeleted': 'Application deleted.',
        'oauth.admin.consentRevoked': 'Permission revoked.',
        'oauth.admin.configSaved': 'Settings saved.',
        'oauth.admin.dynamicRegistration': 'Dynamic registration is {{enabled}}.',
        'common.delete': 'Delete',
        'common.save': 'Save'
      };
      let value = map[key] || key;
      if (params && value.includes('{{')) {
        Object.entries(params).forEach(([k, v]) => {
          value = value.replace(`{{${k}}}`, String(v));
        });
      }
      return value;
    },
    i18n: { language: 'en' }
  })
}));

const baseApiMock = () => ({
  getOAuthClients: vi.fn().mockResolvedValue([]),
  getOAuthConsents: vi.fn().mockResolvedValue([]),
  getOAuthConfig: vi.fn().mockResolvedValue({ config: [], dynamicRegistrationEnabled: true }),
  deleteOAuthClient: vi.fn().mockResolvedValue({ deleted: 'c1' }),
  revokeOAuthConsent: vi.fn().mockResolvedValue({ revoked: 'c1' }),
  updateOAuthConfig: vi.fn().mockResolvedValue({ updated: 1 })
});

describe('OAuthSettings', () => {
  beforeEach(() => {
    vi.resetModules();
    apiMock = baseApiMock() as any;
    vi.doMock('../services/api', () => ({ authApi: apiMock }));
    window.confirm = vi.fn(() => true);
  });

  it('renders the OAuth 2.1 title for admin', async () => {
    const { OAuthSettings: Comp } = await import('./OAuthSettings');
    render(<Comp currentUser={{ id: 'u1', role: 'ADMIN' }} />);
    expect(screen.getByText('OAuth 2.1')).toBeInTheDocument();
    expect(screen.getByText('Apps')).toBeInTheDocument();
  });

  it('hides the config tab for non-admin users', async () => {
    const { OAuthSettings: Comp } = await import('./OAuthSettings');
    render(<Comp currentUser={{ id: 'u1', role: 'MEMBER' }} />);
    await waitFor(() => {
      expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    });
  });

  it('shows empty state when no clients', async () => {
    apiMock.getOAuthClients.mockResolvedValue([]);
    const { OAuthSettings: Comp } = await import('./OAuthSettings');
    render(<Comp currentUser={{ id: 'u1', role: 'ADMIN' }} />);
    await waitFor(() => {
      expect(screen.getByText('No applications registered.')).toBeInTheDocument();
    });
  });

  it('lists registered clients with delete button', async () => {
    apiMock.getOAuthClients.mockResolvedValue([
      {
        id: 'row-1',
        clientId: 'kanban-client-1',
        name: 'open-kanban-mcp',
        redirectUris: [],
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
        tokenEndpointAuthMethod: 'none',
        scopes: ['kanban:read'],
        isFirstParty: false,
        createdAt: new Date().toISOString()
      }
    ]);
    const { OAuthSettings: Comp } = await import('./OAuthSettings');
    render(<Comp currentUser={{ id: 'u1', role: 'ADMIN' }} />);
    await waitFor(() => {
      expect(screen.getByTestId('oauth-client-row')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('oauth-delete-client'));
    await waitFor(() => {
      expect(apiMock.deleteOAuthClient).toHaveBeenCalledWith('kanban-client-1');
    });
  });

  it('shows consents and revokes on click', async () => {
    apiMock.getOAuthConsents.mockResolvedValue([
      {
        clientId: 'kanban-client-1',
        clientName: 'open-kanban-mcp',
        scope: 'kanban:read',
        grantedAt: new Date().toISOString()
      }
    ]);
    const { OAuthSettings: Comp } = await import('./OAuthSettings');
    render(<Comp currentUser={{ id: 'u1', role: 'MEMBER' }} />);
    // Switch to the Permissions tab (default is Apps, which is admin-only).
    fireEvent.click(screen.getByText('Permissions'));
    await waitFor(() => {
      expect(screen.getByTestId('oauth-consent-row')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('oauth-revoke-consent'));
    await waitFor(() => {
      expect(apiMock.revokeOAuthConsent).toHaveBeenCalledWith('kanban-client-1');
    });
  });

  it('saves config edits', async () => {
    apiMock.getOAuthConfig.mockResolvedValue({
      dynamicRegistrationEnabled: true,
      config: [
        { key: 'oauth_access_token_ttl_seconds', value: '3600', default: '3600', description: 'Access token TTL in seconds' },
        { key: 'oauth_device_poll_interval_seconds', value: '10', default: '5', description: 'Device poll interval' }
      ]
    });
    const { OAuthSettings: Comp } = await import('./OAuthSettings');
    render(<Comp currentUser={{ id: 'u1', role: 'ADMIN' }} />);
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Settings'));
    await waitFor(() => {
      expect(screen.getByTestId('oauth-config-oauth_device_poll_interval_seconds')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('oauth-save-config'));
    await waitFor(() => {
      expect(apiMock.updateOAuthConfig).toHaveBeenCalled();
    });
    const payload = apiMock.updateOAuthConfig.mock.calls[0][0] as Record<string, string>;
    expect(payload.oauth_device_poll_interval_seconds).toBe('10');
  });
});