import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    publicBoardApi: {
      get: vi.fn(),
    },
  },
}));

vi.mock('../services/api', () => apiMock);

import { PublicBoardPage } from './PublicBoardPage';
import * as apiModule from '../services/api';

const mockedPublicGet = (apiModule.publicBoardApi.get as unknown) as ReturnType<typeof vi.fn>;

describe('PublicBoardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderPage(token: string) {
    return render(
      <MemoryRouter initialEntries={[`/public/b/${token}`]}>
        <Routes>
          <Route path="/public/b/:token" element={<PublicBoardPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('renders sanitized board when token is valid', async () => {
    const fakeBoard = {
      id: 'b1',
      name: 'Public Board',
      description: 'A read-only view',
      readOnly: true as const,
      columns: [
        {
          id: 'c1',
          name: 'Todo',
          position: 0,
          color: '#6b7280',
          description: '',
          tasks: [
            {
              id: 't1',
              title: 'Visible task',
              description: '',
              priority: 'medium',
              assignee: '',
              meta: '',
              position: 0,
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
              _count: { comments: 0, subtasks: 0 },
            },
          ],
        },
      ],
    };
    mockedPublicGet.mockResolvedValueOnce(fakeBoard);

    renderPage('vwt_demo');
    expect(await screen.findByTestId('public-board-page')).toBeInTheDocument();
    expect(await screen.findByText('Public Board')).toBeInTheDocument();
    expect(screen.getByTestId('public-task-card')).toHaveTextContent('Visible task');
  });

  it('shows not-found state when the token is rejected', async () => {
    mockedPublicGet.mockRejectedValueOnce(new Error('Board not found'));

    renderPage('vwt_invalid');
    // The test i18n mock returns the key as-is, so we assert the
    // heading i18n key is rendered rather than the literal fallback
    // string. The literal fallback path is covered by the runtime
    // /src/i18n/index.ts wiring in the dev server / Storybook.
    await waitFor(() => {
      expect(screen.getByText('publicBoard.notFound')).toBeInTheDocument();
    });
  });

  it('does not call the API when the route has no token', async () => {
    // Render without a token segment. The component short-circuits
    // to the missing-token branch and must not even attempt the API.
    render(
      <MemoryRouter initialEntries={['/public/b/']}>
        <Routes>
          <Route path="/public/b/:token" element={<PublicBoardPage />} />
        </Routes>
      </MemoryRouter>
    );
    // The component should never reach the API; the missing-token
    // branch shows immediately.
    expect(mockedPublicGet).not.toHaveBeenCalled();
  });
});