import { describe, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TemplateMarketplacePage } from './TemplateMarketplacePage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params.count === 'number') {
        if (key === 'marketplace.showColumns' || key === 'marketplace.showColumns_other') {
          return `Preview ${params.count} columns`;
        }
        if (key === 'marketplace.showColumns_one') {
          return `Preview ${params.count} column`;
        }
      }
      if (params && typeof params.presetName === 'string') {
        if (key === 'onboarding.step2Hint') {
          return `Confirm setup for "${params.presetName}"`;
        }
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../hooks/useSetupGuard', () => ({ useSetupGuard: () => undefined }));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    presetTemplatesApi: {
      getAll: vi.fn(),
    },
  },
}));

vi.mock('../services/api', () => apiMock);

import { presetTemplatesApi } from '../services/api';

const mockedGetAll = vi.mocked(presetTemplatesApi.getAll);

const LocationDisplay = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
};

const renderMarketplace = () =>
  render(
    <MemoryRouter initialEntries={['/templates/marketplace']}>
      <TemplateMarketplacePage />
      <LocationDisplay />
    </MemoryRouter>,
  );

const makePreset = (overrides: Partial<{
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  columnsConfig: string;
  sampleTasks: string;
  sampleAgent: string;
  position: number;
}> = {}) => ({
  id: overrides.id ?? overrides.slug ?? 'preset-1',
  slug: overrides.slug ?? 'preset-1',
  name: overrides.name ?? 'Preset One',
  description: overrides.description ?? 'A starter board',
  category: overrides.category ?? 'engineering',
  columnsConfig: overrides.columnsConfig ?? '[{"name":"Backlog","position":0,"color":"#94a3b8"},{"name":"Done","position":1,"color":"#22c55e"}]',
  sampleTasks: overrides.sampleTasks ?? '[]',
  sampleAgent: overrides.sampleAgent ?? '',
  position: overrides.position ?? 0,
});

describe('TemplateMarketplacePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one card per preset returned by the API', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({ slug: 'alpha', name: 'Alpha' }),
      makePreset({ slug: 'beta', name: 'Beta', category: 'support', position: 1 }),
    ]);

    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /marketplace.useTemplate/ })).toHaveLength(2);
  });

  it('shows an empty state when the marketplace returns zero presets', async () => {
    mockedGetAll.mockResolvedValue([]);

    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('marketplace.empty')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /marketplace.useTemplate/ })).not.toBeInTheDocument();
  });

  it('shows a load-failed state when the API rejects', async () => {
    mockedGetAll.mockRejectedValue(new Error('network down'));

    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('app.error.loadFailed')).toBeInTheDocument();
    });
  });

  it('navigates to /onboarding with the preset slug pre-selected when a card CTA is clicked', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({ slug: 'alpha', name: 'Alpha' }),
    ]);

    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /marketplace.useTemplate/ }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/onboarding?preset=alpha');
    });
  });

  it('treats 404 from the API as an empty marketplace (not an error)', async () => {
    mockedGetAll.mockResolvedValue([]);

    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('marketplace.empty')).toBeInTheDocument();
    });
    expect(screen.queryByText('app.error.loadFailed')).not.toBeInTheDocument();
  });

  it('expands column preview when the toggle is clicked', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({
        slug: 'alpha',
        name: 'Alpha',
        columnsConfig: JSON.stringify([
          { name: 'Backlog', position: 0, color: '#94a3b8' },
          { name: 'In progress', position: 1, color: '#3b82f6' },
          { name: 'Done', position: 2, color: '#22c55e' },
        ]),
      }),
    ]);

    renderMarketplace();

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByText('Backlog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Preview 3 columns/ }));
    await waitFor(() => {
      expect(screen.getByText('Backlog')).toBeInTheDocument();
    });
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});