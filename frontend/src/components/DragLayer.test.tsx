import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DragLayer } from './DragLayer';
import type { Task } from '../types/kanban';

vi.mock('@dnd-kit/core', () => ({
  DragOverlay: ({ children }: { children: React.ReactNode }) => children ? children : null,
}));

vi.mock('@/services/api', () => ({
  boardsApi: { getAll: vi.fn(), export: vi.fn() },
  columnsApi: { getByBoard: vi.fn() },
  tasksApi: { update: vi.fn(), delete: vi.fn(), create: vi.fn(), archive: vi.fn(), getById: vi.fn(), getByColumn: vi.fn() },
  commentsApi: { create: vi.fn() },
  authApi: { me: vi.fn() },
  setGlobalErrorHandler: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

const mockTask: Task = {
  id: 'task-1',
  title: 'Test Task',
  description: 'Test Description',
  columnId: 'col-1',
  position: 0,
  priority: 'medium',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  published: true,
  assignee: null,
  meta: null,
  comments: [],
  subtasks: [],
};

describe('DragLayer', () => {
  it('renders nothing when activeTask is null', () => {
    const { container } = render(<DragLayer activeTask={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders TaskCard when activeTask is provided', () => {
    render(<DragLayer activeTask={mockTask} />);
    expect(screen.getByText('Test Task')).toBeInTheDocument();
  });
});