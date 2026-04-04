import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    render(<Column {...defaultProps} />);
    expect(screen.getByText('To Do')).toBeInTheDocument();
  });

  it('renders task count', () => {
    render(<Column {...defaultProps} />);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders empty state when no tasks', () => {
    const emptyColumn = { ...mockColumn, tasks: [] };
    render(<Column {...defaultProps} column={emptyColumn} />);
    expect(screen.getByText('column.noTasks')).toBeInTheDocument();
  });

  it('shows description when column has description', () => {
    const columnWithDesc = { ...mockColumn, description: 'Column description' };
    render(<Column {...defaultProps} column={columnWithDesc} />);
    expect(screen.getByText('column.description')).toBeInTheDocument();
  });

  it('renders column with task card', () => {
    render(<Column {...defaultProps} />);
    expect(screen.getByText('Task 1')).toBeInTheDocument();
  });
});
