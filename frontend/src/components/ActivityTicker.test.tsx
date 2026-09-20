import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ActivityTicker } from './ActivityTicker';

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

vi.mock('@/services/api', () => ({
  activitiesApi: {
    getAll: vi.fn(),
  },
}));

import { activitiesApi } from '@/services/api';

const mockActivities = [
  {
    id: 'a-1',
    userId: 'u-1',
    action: 'CREATE_TASK',
    targetType: 'task',
    targetTitle: 'Hello',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  },
  {
    id: 'a-2',
    userId: 'u-2',
    action: 'DEVICE_APPROVE',
    targetType: 'device',
    targetTitle: 'laptop',
    createdAt: new Date(Date.now() - 30_000).toISOString(),
  },
  {
    id: 'a-3',
    userId: 'u-3',
    action: 'WEBHOOK_TEST',
    targetType: 'webhook',
    targetTitle: 'feishu',
    createdAt: new Date(Date.now() - 10_000).toISOString(),
  },
];

describe('ActivityTicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to the humanized label for actions without an i18n key (s-1257 P0-1)', async () => {
    // Both keys are absent — the ticker should resolve a Title Case label
    // instead of leaking the raw enum (`settings.activities.DEVICE_APPROVE`).
    vi.mocked(activitiesApi.getAll).mockResolvedValue({ activities: mockActivities });

    const { container } = render(<ActivityTicker />);

    await waitFor(() => {
      expect(container.textContent).toContain('Device Approved');
    });
    expect(container.textContent).toContain('Webhook Tested');
    // Sanity: the literal key never appears.
    expect(container.textContent).not.toContain('settings.activities.DEVICE_APPROVE');
    expect(container.textContent).not.toContain('settings.activities.WEBHOOK_TEST');
  });
});
