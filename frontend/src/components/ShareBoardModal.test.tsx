import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    boardsApi: {
      listViewerTokens: vi.fn(),
      mintViewerToken: vi.fn(),
      revokeViewerToken: vi.fn(),
      getViewerEmbedSnippet: vi.fn(),
    },
  },
}));

vi.mock('../services/api', () => apiMock);

import { ShareBoardModal } from './ShareBoardModal';

describe('ShareBoardModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.boardsApi.listViewerTokens.mockResolvedValue({ tokens: [] });
  });

  it('renders mint affordances and lists existing tokens', async () => {
    apiMock.boardsApi.listViewerTokens.mockResolvedValueOnce({
      tokens: [
        {
          id: 'tok-1',
          boardId: 'b1',
          label: 'Stakeholder demo',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    });

    render(<ShareBoardModal open={true} onClose={() => {}} boardId="b1" />);

    expect(await screen.findByText('Stakeholder demo')).toBeInTheDocument();
    expect(screen.getByTestId('share-mint-button')).toBeInTheDocument();
  });

  it('mints a token, shows the plaintext exactly once, and fetches the embed snippet', async () => {
    apiMock.boardsApi.listViewerTokens.mockResolvedValueOnce({ tokens: [] });
    apiMock.boardsApi.mintViewerToken.mockResolvedValueOnce({
      id: 'tok-1',
      boardId: 'b1',
      label: 'demo',
      token: 'vwt_secret_plaintext',
      createdAt: '2024-01-01T00:00:00Z',
    });
    apiMock.boardsApi.getViewerEmbedSnippet.mockResolvedValueOnce({
      src: 'https://example.com/public/b/vwt_secret_plaintext',
      snippet: '<iframe src="https://example.com/public/b/vwt_secret_plaintext"></iframe>',
      height: 600,
      width: '100%',
    });

    render(<ShareBoardModal open={true} onClose={() => {}} boardId="b1" />);

    fireEvent.click(await screen.findByTestId('share-mint-button'));

    const plaintext = await screen.findByTestId('share-plaintext-input');
    expect(plaintext).toHaveValue('vwt_secret_plaintext');
    expect(apiMock.boardsApi.mintViewerToken).toHaveBeenCalledWith('b1', {
      label: '',
      expiresAt: null,
    });
    await waitFor(() => {
      expect(apiMock.boardsApi.getViewerEmbedSnippet).toHaveBeenCalledWith(
        'b1',
        'vwt_secret_plaintext'
      );
    });
  });

  it('revokes a token after confirm', async () => {
    apiMock.boardsApi.listViewerTokens.mockResolvedValueOnce({
      tokens: [
        {
          id: 'tok-2',
          boardId: 'b1',
          label: 'old',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    });
    apiMock.boardsApi.revokeViewerToken.mockResolvedValueOnce({ id: 'tok-2', revoked: true });
    apiMock.boardsApi.listViewerTokens.mockResolvedValueOnce({ tokens: [] });

    render(<ShareBoardModal open={true} onClose={() => {}} boardId="b1" />);

    const revokeButton = await screen.findByTestId('share-revoke-button');
    fireEvent.click(revokeButton);

    // ConfirmDialog renders two buttons (cancel + confirm). The
    // confirm button is the second in DOM order and carries the
    // variant (danger) styling, but since the test i18n mock
    // returns the key as-is we just pick the confirm button by
    // the danger variant class fragment.
    const buttons = await screen.findAllByRole('button');
    const confirmButton = buttons.find((b) =>
      b.className.includes('from-red-500')
    );
    expect(confirmButton).toBeDefined();
    fireEvent.click(confirmButton!);

    await waitFor(() => {
      expect(apiMock.boardsApi.revokeViewerToken).toHaveBeenCalledWith('b1', 'tok-2');
    });
  });
});