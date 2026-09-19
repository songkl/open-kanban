import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { Column } from './Column';
import type { Column as ColumnType } from '@/types/kanban';

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
  }),
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  verticalListSortingStrategy: {},
}));

describe('Column', () => {
  const mockColumn: ColumnType = {
    id: 'col-1',
    name: 'To Do',
    status: 'todo',
    position: 0,
    color: '#3b82f6',
    tasks: [
      {
        id: 'task-1',
        title: 'Task 1',
        description: 'Description 1',
        position: 0,
        priority: 'high',
        assignee: 'John',
        meta: null,
        columnId: 'col-1',
        archived: false,
        archivedAt: null,
        published: true,
        createdBy: 'user-1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        comments: [],
        subtasks: [],
      },
    ],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  const defaultProps = {
    column: mockColumn,
    onTaskClick: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders column name', () => {
    render(<BrowserRouter><Column {...defaultProps} /></BrowserRouter>);
    expect(screen.getByText('To Do')).toBeInTheDocument();
  });

  it('renders task count', () => {
    render(<BrowserRouter><Column {...defaultProps} /></BrowserRouter>);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders empty state when no tasks', () => {
    const emptyColumn = { ...mockColumn, tasks: [] };
    render(<BrowserRouter><Column {...defaultProps} column={emptyColumn} /></BrowserRouter>);
    expect(screen.getByText('column.noTasks')).toBeInTheDocument();
  });

  it('shows description when column has description', () => {
    const columnWithDesc = { ...mockColumn, description: 'Column description' };
    render(<BrowserRouter><Column {...defaultProps} column={columnWithDesc} /></BrowserRouter>);
    expect(screen.getByText('column.description')).toBeInTheDocument();
  });

  it('renders column with task card', () => {
    render(<BrowserRouter><Column {...defaultProps} /></BrowserRouter>);
    expect(screen.getByText('Task 1')).toBeInTheDocument();
  });

  describe('create-task permission gating (s-1053)', () => {
    const emptyColumn = { ...mockColumn, tasks: [] };
    const onOpenAddTask = vi.fn();

    it('renders the click-to-add hint and triggers onOpenAddTask when canCreateTask is true', () => {
      render(
        <BrowserRouter>
          <Column {...defaultProps} column={emptyColumn} onOpenAddTask={onOpenAddTask} canCreateTask={true} />
        </BrowserRouter>
      );
      expect(screen.getByText('column.clickToAddTask')).toBeInTheDocument();
      fireEvent.click(screen.getByText('column.noTasks'));
      expect(onOpenAddTask).toHaveBeenCalledWith('col-1');
    });

    it('disables the empty-state area when canCreateTask is false', () => {
      render(
        <BrowserRouter>
          <Column {...defaultProps} column={emptyColumn} onOpenAddTask={onOpenAddTask} canCreateTask={false} />
        </BrowserRouter>
      );
      expect(screen.queryByText('column.clickToAddTask')).not.toBeInTheDocument();
      expect(screen.getByText('column.noAddPermission')).toBeInTheDocument();
    });

    it('does not trigger onOpenAddTask when the empty-state area is clicked without permission', () => {
      render(
        <BrowserRouter>
          <Column {...defaultProps} column={emptyColumn} onOpenAddTask={onOpenAddTask} canCreateTask={false} />
        </BrowserRouter>
      );
      fireEvent.click(screen.getByText('column.noTasks'));
      expect(onOpenAddTask).not.toHaveBeenCalled();
    });

    it('exposes a tooltip describing the missing permission', () => {
      render(
        <BrowserRouter>
          <Column {...defaultProps} column={emptyColumn} onOpenAddTask={onOpenAddTask} canCreateTask={false} />
        </BrowserRouter>
      );
      const emptyState = screen.getByText('column.noTasks').parentElement;
      expect(emptyState).toHaveAttribute('title', 'column.noAddPermission');
    });
  });

  describe('mobile tap targets (s-1192)', () => {
    it('renders the task count button with at least 32px tap target', () => {
      render(
        <BrowserRouter>
          <Column {...defaultProps} />
        </BrowserRouter>
      );
      const countButton = screen.getByRole('button', { name: /column\.viewColumnDetail/i });
      expect(countButton.className).toContain('min-h-[32px]');
      expect(countButton.className).toContain('min-w-[32px]');
    });

    it('wraps the select-all checkbox in a >= 32px tap target', () => {
      render(
        <BrowserRouter>
          <Column {...defaultProps} onSelectAllTasks={vi.fn()} />
        </BrowserRouter>
      );
      // s-1244 (PM review s-1243 P0-1): the column select-all label
      // resolves to common.selectAll instead of the legacy
      // column.selectAll key. The test harness mocks t(key) → key
      // (see src/test/setup.ts), so the aria-label literal is the
      // dotted key.
      const checkbox = screen.getByLabelText('common.selectAll');
      const wrapper = checkbox.parentElement;
      expect(wrapper?.className).toContain('min-h-[32px]');
      expect(wrapper?.className).toContain('min-w-[32px]');
    });

    it('keeps the header at a minimum height for reliable touch interaction', () => {
      const { container } = render(
        <BrowserRouter>
          <Column {...defaultProps} />
        </BrowserRouter>
      );
      const header = container.querySelector('div[style*="background-color"]');
      expect(header?.className).toContain('min-h-[56px]');
    });
  });

  // s-1212 — column-header ⋯ menu (PM_REVIEW §3.2 finding #4).
  // The Column component owns surfacing the menu; the parent owns
  // the confirmation dialog + API call. We verify the three wiring
  // contracts here:
  //   1. No menu button when none of the bulk handlers are passed.
  //   2. The button opens a dropdown listing all three actions.
  //   3. Each action fires the matching handler with the column.
  describe('column-level bulk menu (s-1212)', () => {
    const onArchive = vi.fn();
    const onComplete = vi.fn();
    const onExport = vi.fn();

    it('hides the menu button entirely when no bulk handlers are passed', () => {
      render(
        <BrowserRouter>
          <Column {...defaultProps} />
        </BrowserRouter>
      );
      expect(screen.queryByTestId(`column-menu-button-${mockColumn.id}`)).toBeNull();
    });

    it('renders a menu button with the three actions when handlers are wired', async () => {
      const user = userEvent.setup();
      render(
        <BrowserRouter>
          <Column
            {...defaultProps}
            onColumnArchiveAll={onArchive}
            onColumnMarkAllCompleted={onComplete}
            onColumnExportCsv={onExport}
          />
        </BrowserRouter>
      );

      const trigger = screen.getByTestId(`column-menu-button-${mockColumn.id}`);
      expect(trigger).toBeInTheDocument();
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');

      await user.click(trigger);

      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByTestId(`column-menu-archive-${mockColumn.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`column-menu-complete-${mockColumn.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`column-menu-export-${mockColumn.id}`)).toBeInTheDocument();
    });

    it('invokes onColumnArchiveAll when the archive action is clicked', async () => {
      const user = userEvent.setup();
      render(
        <BrowserRouter>
          <Column
            {...defaultProps}
            onColumnArchiveAll={onArchive}
            onColumnMarkAllCompleted={onComplete}
            onColumnExportCsv={onExport}
          />
        </BrowserRouter>
      );
      await user.click(screen.getByTestId(`column-menu-button-${mockColumn.id}`));
      await user.click(screen.getByTestId(`column-menu-archive-${mockColumn.id}`));

      expect(onArchive).toHaveBeenCalledWith(mockColumn);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onExport).not.toHaveBeenCalled();
    });

    it('invokes onColumnMarkAllCompleted when the complete action is clicked', async () => {
      const user = userEvent.setup();
      render(
        <BrowserRouter>
          <Column
            {...defaultProps}
            onColumnArchiveAll={onArchive}
            onColumnMarkAllCompleted={onComplete}
            onColumnExportCsv={onExport}
          />
        </BrowserRouter>
      );
      await user.click(screen.getByTestId(`column-menu-button-${mockColumn.id}`));
      await user.click(screen.getByTestId(`column-menu-complete-${mockColumn.id}`));

      expect(onComplete).toHaveBeenCalledWith(mockColumn);
      expect(onArchive).not.toHaveBeenCalled();
      expect(onExport).not.toHaveBeenCalled();
    });

    it('invokes onColumnExportCsv when the export action is clicked', async () => {
      const user = userEvent.setup();
      render(
        <BrowserRouter>
          <Column
            {...defaultProps}
            onColumnArchiveAll={onArchive}
            onColumnMarkAllCompleted={onComplete}
            onColumnExportCsv={onExport}
          />
        </BrowserRouter>
      );
      await user.click(screen.getByTestId(`column-menu-button-${mockColumn.id}`));
      await user.click(screen.getByTestId(`column-menu-export-${mockColumn.id}`));

      expect(onExport).toHaveBeenCalledWith(mockColumn);
      expect(onArchive).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('closes the menu after an action is clicked', async () => {
      const user = userEvent.setup();
      render(
        <BrowserRouter>
          <Column
            {...defaultProps}
            onColumnArchiveAll={onArchive}
          />
        </BrowserRouter>
      );
      const trigger = screen.getByTestId(`column-menu-button-${mockColumn.id}`);
      await user.click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      await user.click(screen.getByTestId(`column-menu-archive-${mockColumn.id}`));
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('disables all three actions when the column has no tasks', () => {
      const emptyColumn = { ...mockColumn, tasks: [] };
      render(
        <BrowserRouter>
          <Column
            {...defaultProps}
            column={emptyColumn}
            onColumnArchiveAll={onArchive}
            onColumnMarkAllCompleted={onComplete}
            onColumnExportCsv={onExport}
          />
        </BrowserRouter>
      );
      // The ⋯ button is rendered (column exists), but the actions
      // surface only after the user clicks the trigger. Validate
      // the trigger still works and then check the disabled state.
      const trigger = screen.getByTestId(`column-menu-button-${mockColumn.id}`);
      fireEvent.click(trigger);
      expect(screen.getByTestId(`column-menu-archive-${mockColumn.id}`)).toBeDisabled();
      expect(screen.getByTestId(`column-menu-complete-${mockColumn.id}`)).toBeDisabled();
      expect(screen.getByTestId(`column-menu-export-${mockColumn.id}`)).toBeDisabled();
    });
  });
});
