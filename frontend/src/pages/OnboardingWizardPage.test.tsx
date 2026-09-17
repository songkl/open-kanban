import { describe, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { OnboardingWizardPage } from './OnboardingWizardPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
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
    onboardingApi: {
      quickstart: vi.fn(),
    },
  },
}));

vi.mock('../services/api', () => apiMock);

import { presetTemplatesApi, onboardingApi } from '../services/api';

const mockedGetAll = vi.mocked(presetTemplatesApi.getAll);
const mockedQuickstart = vi.mocked(onboardingApi.quickstart);

const LocationDisplay = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
};

const renderWizard = (initialEntries: string[] = ['/onboarding']) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <OnboardingWizardPage />
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
  columnsConfig: overrides.columnsConfig ?? '[{"name":"Backlog","position":0}]',
  sampleTasks: overrides.sampleTasks ?? '[{"title":"Try me","columnIndex":0}]',
  sampleAgent: overrides.sampleAgent ?? 'Preset Bot',
  position: overrides.position ?? 0,
});

describe('OnboardingWizardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the pick step by default with all presets', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({ slug: 'alpha', name: 'Alpha' }),
      makePreset({ slug: 'beta', name: 'Beta' }),
    ]);

    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('onboarding.step1Title')).toBeInTheDocument();
    });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('skips pick step when ?preset=<slug> is in the URL', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({ slug: 'alpha', name: 'Alpha preset' }),
    ]);

    renderWizard(['/onboarding?preset=alpha']);

    await waitFor(() => {
      expect(screen.getByText('onboarding.step2Title')).toBeInTheDocument();
    });
    expect(screen.queryByText('onboarding.step1Title')).not.toBeInTheDocument();
  });

  it('moves to configure when a preset card is clicked', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({ slug: 'alpha', name: 'Alpha preset' }),
    ]);

    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Alpha preset')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Alpha preset'));
    await waitFor(() => {
      expect(screen.getByText('onboarding.step2Title')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('Alpha preset')).toBeInTheDocument();
  });

  it('submits the wizard and surfaces the agent token on success', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({ slug: 'alpha', name: 'Alpha preset', sampleAgent: 'Alpha Bot' }),
    ]);
    mockedQuickstart.mockResolvedValue({
      boardId: 'new-board-id',
      boardName: 'Alpha preset',
      agentId: 'agent-id',
      agentToken: 'agent-secret-token',
      demoTaskId: 'task-id',
    });

    renderWizard(['/onboarding?preset=alpha']);

    await waitFor(() => {
      expect(screen.getByText('onboarding.step2Title')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /onboarding.create/ }));

    await waitFor(() => {
      expect(mockedQuickstart).toHaveBeenCalledWith(expect.objectContaining({
        presetSlug: 'alpha',
      }));
    });
    await waitFor(() => {
      expect(screen.getByText('onboarding.doneTitle')).toBeInTheDocument();
    });
    expect(screen.getByText('agent-secret-token')).toBeInTheDocument();
  });

  it('shows a friendly error if quickstart fails', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({ slug: 'alpha', name: 'Alpha preset' }),
    ]);
    mockedQuickstart.mockRejectedValue(new Error('boom'));

    renderWizard(['/onboarding?preset=alpha']);

    await waitFor(() => {
      expect(screen.getByText('onboarding.step2Title')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /onboarding.create/ }));

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  it('navigates to the new board on the done screen', async () => {
    mockedGetAll.mockResolvedValue([
      makePreset({ slug: 'alpha', name: 'Alpha preset' }),
    ]);
    mockedQuickstart.mockResolvedValue({
      boardId: 'new-board-id',
      boardName: 'Alpha preset',
      agentId: 'a',
      agentToken: 't',
      demoTaskId: 'task',
    });

    renderWizard(['/onboarding?preset=alpha']);

    await waitFor(() => {
      expect(screen.getByText('onboarding.step2Title')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /onboarding.create/ }));
    await waitFor(() => {
      expect(screen.getByText('onboarding.doneTitle')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /onboarding.openBoard/ }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/board/new-board-id');
    });
  });
});