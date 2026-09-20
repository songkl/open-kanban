import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';
import { ActivitiesSettings } from './ActivitiesSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.count === 'number') {
        return `${key}(${opts.count})`;
      }
      return key;
    },
    i18n: { language: 'en', exists: () => false },
  }),
}));

vi.mock('../../services/api', () => ({
  activitiesApi: {
    getAll: vi.fn(),
  },
}));

import { activitiesApi } from '../../services/api';

const mockActivities = [
  {
    id: 'a-1',
    userId: 'u-1',
    action: 'CREATE_TASK',
    targetType: 'task',
    targetTitle: 'Hello',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'a-2',
    userId: 'u-2',
    action: 'DEVICE_APPROVE',
    targetType: 'device',
    targetTitle: 'laptop',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'a-3',
    userId: 'u-3',
    action: 'WEBHOOK_TEST',
    targetType: 'webhook',
    targetTitle: 'feishu',
    createdAt: new Date().toISOString(),
  },
];

describe('ActivitiesSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to the humanized label when no i18n key exists (s-1257 P0-1)', async () => {
    vi.mocked(activitiesApi.getAll).mockResolvedValue({ activities: mockActivities });

    const { container } = render(
      <ActivitiesSettings
        currentUser={{ id: 'u-1', role: 'ADMIN' }}
        userNicknameMap={{}}
      />,
    );

    // The settings panel only loads activities when the operator clicks
    // "Apply filter". Trigger it so the humanized labels render in the
    // list pane.
    fireEvent.click(screen.getByRole('button', { name: /settings\.applyFilter/ }));

    await waitFor(() => {
      expect(container.textContent).toContain('Device Approved');
    });
    expect(container.textContent).toContain('Webhook Tested');
    // Raw enum must not leak through.
    expect(container.textContent).not.toContain('settings.activities.DEVICE_APPROVE');
    expect(container.textContent).not.toContain('settings.activities.WEBHOOK_TEST');
  });
});
