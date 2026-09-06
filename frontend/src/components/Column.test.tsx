import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
