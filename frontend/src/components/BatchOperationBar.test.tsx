import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BatchOperationBar } from './BatchOperationBar';
import type { Column as ColumnType } from '../types/kanban';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'task.selectedCount') return `Selected ${options?.count || 0} tasks`;
      if (key === 'task.moveToColumn') return 'Move to Column';
      if (key === 'task.setPriority') return 'Set Priority';
      if (key === 'task.priority.high') return 'High';
      if (key === 'task.priority.medium') return 'Medium';
      if (key === 'task.priority.low') return 'Low';
      if (key === 'task.setAssignee') return 'Set Assignee';
      if (key === 'task.clearAssignee') return 'Clear Assignee';
      if (key === 'task.archive') return 'Archive';
      if (key === 'task.delete') return 'Delete';
      if (key === 'task.clearSelection') return 'Clear Selection';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

const mockColumns: ColumnType[] = [
  {
    id: 'col-1',
    name: 'To Do',
    status: 'todo',
    position: 0,
    color: '#3b82f6',
    tasks: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
  {
    id: 'col-2',
    name: 'In Progress',
    status: 'in_progress',
    position: 1,
    color: '#f59e0b',
    tasks: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
];

describe('BatchOperationBar', () => {
  it('renders selected count', () => {
    render(
      <BatchOperationBar
        selectedTasks={new Set(['task-1', 'task-2'])}
        columns={mockColumns}
        uniqueAssignees={[]}
        onBatchMove={vi.fn()}
        onBatchUpdatePriority={vi.fn()}
        onBatchUpdateAssignee={vi.fn()}
        onBatchArchive={vi.fn()}
        onBatchDelete={vi.fn()}
        onClearSelection={vi.fn()}
      />
    );
    expect(screen.getByText(/Selected 2 tasks/)).toBeInTheDocument();
  });

  it('renders column options for move', () => {
    render(
      <BatchOperationBar
        selectedTasks={new Set(['task-1'])}
        columns={mockColumns}
        uniqueAssignees={[]}
        onBatchMove={vi.fn()}
        onBatchUpdatePriority={vi.fn()}
        onBatchUpdateAssignee={vi.fn()}
        onBatchArchive={vi.fn()}
        onBatchDelete={vi.fn()}
        onClearSelection={vi.fn()}
      />
    );
    expect(screen.getAllByText('Move to Column').length).toBeGreaterThan(0);
    expect(screen.getByText('To Do')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });

  it('calls onBatchMove when selecting a column', () => {
    const onBatchMove = vi.fn();
    render(
      <BatchOperationBar
        selectedTasks={new Set(['task-1'])}
        columns={mockColumns}
        uniqueAssignees={[]}
        onBatchMove={onBatchMove}
        onBatchUpdatePriority={vi.fn()}
        onBatchUpdateAssignee={vi.fn()}
        onBatchArchive={vi.fn()}
        onBatchDelete={vi.fn()}
        onClearSelection={vi.fn()}
      />
    );
    const selects = screen.getAllByRole('combobox');
    const moveSelect = selects[0];
    fireEvent.change(moveSelect, { target: { value: 'col-2' } });
    expect(onBatchMove).toHaveBeenCalledWith('col-2');
  });

  it('renders priority options', () => {
    render(
      <BatchOperationBar
        selectedTasks={new Set(['task-1'])}
        columns={mockColumns}
        uniqueAssignees={[]}
        onBatchMove={vi.fn()}
        onBatchUpdatePriority={vi.fn()}
        onBatchUpdateAssignee={vi.fn()}
        onBatchArchive={vi.fn()}
        onBatchDelete={vi.fn()}
        onClearSelection={vi.fn()}
      />
    );
    expect(screen.getAllByText('Set Priority').length).toBeGreaterThan(0);
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
  });

  it('calls onClearSelection when clear button is clicked', () => {
    const onClearSelection = vi.fn();
    render(
      <BatchOperationBar
        selectedTasks={new Set(['task-1'])}
        columns={mockColumns}
        uniqueAssignees={[]}
        onBatchMove={vi.fn()}
        onBatchUpdatePriority={vi.fn()}
        onBatchUpdateAssignee={vi.fn()}
        onBatchArchive={vi.fn()}
        onBatchDelete={vi.fn()}
        onClearSelection={onClearSelection}
      />
    );
    fireEvent.click(screen.getByText('Clear Selection'));
    expect(onClearSelection).toHaveBeenCalled();
  });
});