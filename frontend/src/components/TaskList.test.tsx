import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskList } from './TaskList';
import type { Column as ColumnType } from '../types/kanban';
import { DndProvider } from '@dnd-kit/core';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'column.noTasks') return 'No tasks';
      if (key === 'column.clickToAddTask') return 'Click to add a task';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

const mockColumn: ColumnType = {
  id: 'col-1',
  name: 'To Do',
  status: 'todo',
  position: 0,
  color: '#3b82f6',
  tasks: [],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const renderWithDndProvider = (ui: React.ReactElement) => {
  return render(<DndProvider>{ui}</DndProvider>);
};

describe('TaskList', () => {
  it('renders nothing when column is null', () => {
    const { container } = renderWithDndProvider(
      <TaskList
        column={null as any}
        onTaskClick={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders empty state when tasks array is empty', () => {
    renderWithDndProvider(
      <TaskList
        column={mockColumn}
        onTaskClick={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );
    expect(screen.getByText('No tasks')).toBeInTheDocument();
    expect(screen.getByText('Click to add a task')).toBeInTheDocument();
  });

  it('calls onOpenAddTask when clicking empty state', () => {
    const onOpenAddTask = vi.fn();
    renderWithDndProvider(
      <TaskList
        column={mockColumn}
        onTaskClick={vi.fn()}
        onOpenAddTask={onOpenAddTask}
        onLoadMore={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Click to add a task'));
    expect(onOpenAddTask).toHaveBeenCalledWith('col-1');
  });
});