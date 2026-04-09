import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoardActionsMenu } from './BoardActionsMenu';
import type { User } from '@/types/kanban';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('BoardActionsMenu', () => {
  const defaultProps = {
    showMoreMenu: false,
    showExportMenu: false,
    currentUser: null as User | null,
    onSetShowMoreMenu: vi.fn(),
    onSetShowExportMenu: vi.fn(),
    moreMenuRef: { current: null } as React.RefObject<HTMLDivElement | null>,
    exportMenuRef: { current: null } as React.RefObject<HTMLDivElement | null>,
    onExport: vi.fn(),
    onReset: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderMenu = (props = defaultProps) => {
    return render(
      <MemoryRouter>
        <BoardActionsMenu {...props} />
      </MemoryRouter>
    );
  };

  it('should render more menu button', () => {
    const { container } = renderMenu();
    expect(container.querySelector('button')).toBeInTheDocument();
  });

  it('should not show menu items when showMoreMenu is false', () => {
    renderMenu();
    expect(screen.queryByText(/nav\.manageBoards/i)).not.toBeInTheDocument();
  });

  it('should show menu items when showMoreMenu is true', () => {
    renderMenu({ ...defaultProps, showMoreMenu: true });
    expect(screen.getByText(/nav\.manageBoards/i)).toBeInTheDocument();
    expect(screen.getByText(/nav\.drafts/i)).toBeInTheDocument();
    expect(screen.getByText(/nav\.history/i)).toBeInTheDocument();
    expect(screen.getByText(/nav\.completed/i)).toBeInTheDocument();
  });

  it('should show admin menu items when currentUser is ADMIN', () => {
    renderMenu({ ...defaultProps, showMoreMenu: true, currentUser: { id: '1', username: 'admin', role: 'ADMIN' } as User });
    expect(screen.getByText(/nav\.admin/i)).toBeInTheDocument();
    expect(screen.getByText(/nav\.activityLog/i)).toBeInTheDocument();
    expect(screen.getByText(/nav\.agentActivity/i)).toBeInTheDocument();
  });

  it('should not show admin menu items when currentUser is not ADMIN', () => {
    renderMenu({ ...defaultProps, showMoreMenu: true, currentUser: { id: '1', username: 'user', role: 'USER' } as User });
    expect(screen.queryByText(/nav\.admin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/nav\.activityLog/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/nav\.agentActivity/i)).not.toBeInTheDocument();
  });

  it('should show export submenu when showExportMenu is true', () => {
    renderMenu({ ...defaultProps, showMoreMenu: true, showExportMenu: true });
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText('CSV')).toBeInTheDocument();
  });

  it('should show reset board option', () => {
    renderMenu({ ...defaultProps, showMoreMenu: true });
    expect(screen.getByText(/nav\.resetBoard/i)).toBeInTheDocument();
  });

  it('should call onSetShowMoreMenu when more button is clicked', () => {
    const { container } = renderMenu();
    container.querySelector('button')?.click();
    expect(defaultProps.onSetShowMoreMenu).toHaveBeenCalledWith(true);
  });

  it('should call onExport when JSON export is clicked', () => {
    renderMenu({ ...defaultProps, showMoreMenu: true, showExportMenu: true });
    screen.getByText('JSON').click();
    expect(defaultProps.onExport).toHaveBeenCalledWith('json');
  });

  it('should call onExport when CSV export is clicked', () => {
    renderMenu({ ...defaultProps, showMoreMenu: true, showExportMenu: true });
    screen.getByText('CSV').click();
    expect(defaultProps.onExport).toHaveBeenCalledWith('csv');
  });

  it('should call onReset when reset board is clicked', () => {
    renderMenu({ ...defaultProps, showMoreMenu: true });
    screen.getByText(/nav\.resetBoard/i).click();
    expect(defaultProps.onReset).toHaveBeenCalled();
    expect(defaultProps.onSetShowMoreMenu).toHaveBeenCalledWith(false);
  });
});