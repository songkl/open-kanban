import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardSelector } from './BoardSelector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

describe('BoardSelector', () => {
  const defaultProps = {
    boards: [{ id: 'board-1', name: 'Test Board', createdAt: '2024-01-01', updatedAt: '2024-01-01' }],
    currentBoard: { id: 'board-1', name: 'Test Board', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    boardIdFromUrl: 'board-1',
    showDropdown: false,
    onToggleDropdown: vi.fn(),
    onSelectBoard: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders board name when currentBoard is provided', () => {
    render(<BoardSelector {...defaultProps} />);
    expect(screen.getByText('Test Board')).toBeInTheDocument();
  });

  it('renders selectBoard translation when no boards available', () => {
    render(<BoardSelector {...defaultProps} boards={[]} currentBoard={null} />);
    expect(screen.getByText('board.selectBoard')).toBeInTheDocument();
  });

  it('calls onToggleDropdown when button is clicked', async () => {
    const user = userEvent.setup();
    render(<BoardSelector {...defaultProps} />);
    const button = screen.getByRole('button', { name: /Test Board/ });
    await user.click(button);
    expect(defaultProps.onToggleDropdown).toHaveBeenCalledTimes(1);
  });

  it('shows dropdown items when showDropdown is true', () => {
    render(<BoardSelector {...defaultProps} showDropdown={true} boards={[
      { id: 'board-1', name: 'Board One', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      { id: 'board-2', name: 'Board Two', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    ]} />);
    expect(screen.getByText('Board One')).toBeInTheDocument();
    expect(screen.getByText('Board Two')).toBeInTheDocument();
  });

  it('calls onSelectBoard when board is selected from dropdown', async () => {
    const user = userEvent.setup();
    render(<BoardSelector {...defaultProps} showDropdown={true} boards={[
      { id: 'board-1', name: 'Board One', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      { id: 'board-2', name: 'Board Two', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    ]} />);
    await user.click(screen.getByText('Board Two'));
    expect(defaultProps.onSelectBoard).toHaveBeenCalledWith('board-2');
  });

  it('highlights current board in dropdown', () => {
    render(<BoardSelector {...defaultProps} showDropdown={true} boards={[
      { id: 'board-1', name: 'Board One', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      { id: 'board-2', name: 'Board Two', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    ]} boardIdFromUrl="board-1" />);
    const boardOneButton = screen.getByRole('button', { name: 'Board One' });
    expect(boardOneButton).toHaveClass('bg-blue-50');
  });
});
