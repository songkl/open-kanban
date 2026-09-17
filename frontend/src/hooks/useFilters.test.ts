import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFilters, EMPTY_CUSTOM_FIELD_FILTER } from './useFilters';
import type { Column as ColumnType, CustomField } from '@/types/kanban';

const createMockTask = (id: string, overrides = {}) => ({
  id,
  title: `Task ${id}`,
  description: '',
  position: 0,
  priority: 'medium' as const,
  assignee: null,
  meta: null,
  columnId: 'col-1',
  archived: false,
  archivedAt: null,
  published: true,
  createdBy: 'user-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  comments: [],
  subtasks: [],
  ...overrides,
});

const mockColumns: ColumnType[] = [
  {
    id: 'col-1',
    name: 'To Do',
    status: 'todo',
    position: 0,
    color: '#3b82f6',
    tasks: [
      createMockTask('task-1', { priority: 'high', assignee: 'Alice', createdAt: new Date().toISOString() }),
      createMockTask('task-2', { priority: 'medium', assignee: 'Bob', createdAt: new Date().toISOString() }),
      createMockTask('task-3', { priority: 'low', createdAt: new Date(Date.now() - 86400000 * 30).toISOString() }),
    ],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
  {
    id: 'col-2',
    name: 'In Progress',
    status: 'in_progress',
    position: 1,
    color: '#f59e0b',
    tasks: [
      createMockTask('task-4', { priority: 'high', assignee: 'Alice', columnId: 'col-2', createdAt: new Date().toISOString() }),
    ],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
];

describe('useFilters', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should initialize with empty filters', () => {
      const { result } = renderHook(() => useFilters());
      expect(result.current.filters).toEqual({
        priority: '',
        assignee: '',
        searchQuery: '',
        dateRange: '',
        tag: '',
        customField: EMPTY_CUSTOM_FIELD_FILTER,
      });
    });

    it('should initialize with empty filterPresets from localStorage', () => {
      const { result } = renderHook(() => useFilters());
      expect(result.current.filterPresets).toEqual([]);
    });

    it('should initialize with empty searchQuery', () => {
      const { result } = renderHook(() => useFilters());
      expect(result.current.searchQuery).toBe('');
    });
  });

  describe('setFilters', () => {
    it('should update filters state', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: 'high', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.filters.priority).toBe('high');
    });
  });

  describe('setSearchQuery', () => {
    it('should update searchQuery state', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setSearchQuery('test');
      });
      expect(result.current.searchQuery).toBe('test');
    });
  });

  describe('clearFilters', () => {
    it('should reset all filters to empty', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      act(() => {
        result.current.setFilters({ priority: 'high', assignee: 'Alice', searchQuery: 'test', dateRange: 'today', tag: 'bug', customField: { fieldId: 'a', value: 'b' } });
        result.current.setSearchQuery('test');
      });
      act(() => {
        result.current.clearFilters();
      });
      expect(result.current.filters).toEqual({
        priority: '',
        assignee: '',
        searchQuery: '',
        dateRange: '',
        tag: '',
        customField: EMPTY_CUSTOM_FIELD_FILTER,
      });
      expect(result.current.searchQuery).toBe('');
    });
  });

  describe('uniqueAssignees', () => {
    it('should extract unique assignees from all tasks', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      expect(result.current.uniqueAssignees).toEqual(['Alice', 'Bob']);
    });

    it('should return empty array when no tasks have assignees', () => {
      const columnsWithoutAssignees = mockColumns.map(col => ({
        ...col,
        tasks: col.tasks.map(task => ({ ...task, assignee: null })),
      }));
      const { result } = renderHook(() => useFilters({ columns: columnsWithoutAssignees }));
      expect(result.current.uniqueAssignees).toEqual([]);
    });
  });

  describe('uniqueTags', () => {
    it('should extract unique tags from tasks with meta.标签', () => {
      const columnsWithTags: ColumnType[] = mockColumns.map(col => ({
        ...col,
        tasks: col.tasks.map((task, i) => ({
          ...task,
          meta: i === 0 ? { '标签': 'bug' } : i === 1 ? { '标签': 'feature' } : null,
        })),
      }));
      const { result } = renderHook(() => useFilters({ columns: columnsWithTags }));
      expect(result.current.uniqueTags).toEqual(['bug', 'feature']);
    });

    it('should return empty array when no tasks have tags', () => {
      const columnsWithoutTags: ColumnType[] = mockColumns.map(col => ({
        ...col,
        tasks: col.tasks.map(task => ({ ...task, meta: null })),
      }));
      const { result } = renderHook(() => useFilters({ columns: columnsWithoutTags }));
      expect(result.current.uniqueTags).toEqual([]);
    });
  });

  describe('isInDateRange', () => {
    it('should return true when dateRange is empty', () => {
      const { result } = renderHook(() => useFilters());
      expect(result.current.isInDateRange(new Date().toISOString())).toBe(true);
    });

    it('should return true for today when dateRange is today', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: 'today', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.isInDateRange(new Date().toISOString())).toBe(true);
    });

    it('should return false for old date when dateRange is today', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: 'today', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      const oldDate = new Date(Date.now() - 86400000 * 2).toISOString();
      expect(result.current.isInDateRange(oldDate)).toBe(false);
    });

    it('should return true for thisWeek when date is within current week', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: 'thisWeek', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.isInDateRange(new Date().toISOString())).toBe(true);
    });

    it('should return true for thisMonth when date is within current month', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: 'thisMonth', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.isInDateRange(new Date().toISOString())).toBe(true);
    });
  });

  describe('getFilteredColumns', () => {
    it('should return all columns when no filters are active', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      const filtered = result.current.getFilteredColumns();
      expect(filtered).toEqual(mockColumns);
    });

    it('should filter by searchQuery in title', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: 'Task task-1', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      const filtered = result.current.getFilteredColumns();
      expect(filtered[0].tasks.length).toBe(1);
      expect(filtered[0].tasks[0].id).toBe('task-1');
    });

    it('should filter by searchQuery in description', () => {
      const columnsWithDesc = mockColumns.map(col => ({
        ...col,
        tasks: col.tasks.map(task =>
          task.id === 'task-1' ? { ...task, description: 'Special description' } : task
        ),
      }));
      const { result } = renderHook(() => useFilters({ columns: columnsWithDesc }));
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: 'Special', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      const filtered = result.current.getFilteredColumns();
      expect(filtered[0].tasks.length).toBe(1);
    });

    it('should filter by searchQuery in id', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: 'task-1', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      const filtered = result.current.getFilteredColumns();
      expect(filtered[0].tasks.length).toBe(1);
    });

    it('should filter by priority', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      act(() => {
        result.current.setFilters({ priority: 'high', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      const filtered = result.current.getFilteredColumns();
      expect(filtered[0].tasks.length).toBe(1);
      expect(filtered[0].tasks[0].priority).toBe('high');
    });

    it('should filter by assignee', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      act(() => {
        result.current.setFilters({ priority: '', assignee: 'Alice', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      const filtered = result.current.getFilteredColumns();
      expect(filtered[0].tasks.length).toBe(1);
      expect(filtered[0].tasks[0].assignee).toBe('Alice');
    });

    it('should filter by tag', () => {
      const columnsWithTags: ColumnType[] = mockColumns.map(col => ({
        ...col,
        tasks: col.tasks.map((task, i) => ({
          ...task,
          meta: i === 0 ? { '标签': 'bug' } : null,
        })),
      }));
      const { result } = renderHook(() => useFilters({ columns: columnsWithTags }));
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: 'bug', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      const filtered = result.current.getFilteredColumns();
      expect(filtered[0].tasks.length).toBe(1);
    });

    it('should combine multiple filters', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      act(() => {
        result.current.setFilters({ priority: 'high', assignee: 'Alice', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      const filtered = result.current.getFilteredColumns();
      expect(filtered[0].tasks.length).toBe(1);
      expect(filtered[0].tasks[0].priority).toBe('high');
      expect(filtered[0].tasks[0].assignee).toBe('Alice');
    });
  });

  describe('hasActiveFilters', () => {
    it('should return false when no filters are active', () => {
      const { result } = renderHook(() => useFilters());
      expect(result.current.hasActiveFilters).toBe(false);
    });

    it('should return true when searchQuery is set', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: 'test', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should return true when priority is set', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: 'high', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should return true when assignee is set', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: 'Alice', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should return true when dateRange is set', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: 'today', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should return true when tag is set', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: 'bug', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should return true when a custom field filter is set', () => {
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: { fieldId: 'a', value: '' } });
      });
      expect(result.current.hasActiveFilters).toBe(true);
    });
  });

  describe('filterPresets', () => {
    it('should save preset to localStorage', () => {
      const { result } = renderHook(() => useFilters());
      vi.spyOn(window, 'prompt').mockReturnValue('My Preset');
      act(() => {
        result.current.setFilters({ priority: 'high', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
      });
      act(() => {
        result.current.saveCurrentAsPreset();
      });
      const saved = localStorage.getItem('filterPresets');
      expect(saved).toBeTruthy();
      const presets = JSON.parse(saved!);
      expect(presets.length).toBe(1);
      expect(presets[0].name).toBe('My Preset');
      expect(presets[0].filters.priority).toBe('high');
    });

    it('should not save preset if prompt returns empty string', () => {
      const { result } = renderHook(() => useFilters());
      vi.spyOn(window, 'prompt').mockReturnValue('');
      act(() => {
        result.current.saveCurrentAsPreset();
      });
      const saved = localStorage.getItem('filterPresets');
      expect(saved).toBe('[]');
    });

    it('should load presets from localStorage on init', () => {
      localStorage.setItem('filterPresets', JSON.stringify([
        { id: '1', name: 'Test Preset', filters: { priority: 'low', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER } }
      ]));
      const { result } = renderHook(() => useFilters());
      expect(result.current.filterPresets.length).toBe(1);
      expect(result.current.filterPresets[0].name).toBe('Test Preset');
    });

    it('should apply preset filters', () => {
      localStorage.setItem('filterPresets', JSON.stringify([
        { id: '1', name: 'Test Preset', filters: { priority: 'low', assignee: 'Bob', searchQuery: 'test', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER } }
      ]));
      const { result } = renderHook(() => useFilters());
      act(() => {
        result.current.applyPreset(result.current.filterPresets[0]);
      });
      expect(result.current.filters.priority).toBe('low');
      expect(result.current.filters.assignee).toBe('Bob');
      expect(result.current.filters.searchQuery).toBe('test');
    });

    it('should delete preset', () => {
      localStorage.setItem('filterPresets', JSON.stringify([
        { id: '1', name: 'Test Preset', filters: { priority: 'low', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER } },
        { id: '2', name: 'Another Preset', filters: { priority: 'high', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER } }
      ]));
      const { result } = renderHook(() => useFilters());
      expect(result.current.filterPresets.length).toBe(2);
      act(() => {
        result.current.deletePreset('1');
      });
      expect(result.current.filterPresets.length).toBe(1);
      expect(result.current.filterPresets[0].id).toBe('2');
    });

    it('should set filterPresets directly', () => {
      const { result } = renderHook(() => useFilters());
      const newPresets = [
        { id: '1', name: 'Preset 1', filters: { priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER } }
      ];
      act(() => {
        result.current.setFilterPresets(newPresets);
      });
      expect(result.current.filterPresets).toEqual(newPresets);
    });
  });

  describe('customField filter', () => {
    const customFields: CustomField[] = [
      { id: 'cf-1', name: 'Severity', type: 'single-select', color: '#ef4444', options: ['low', 'high'] },
      { id: 'cf-2', name: 'Labels', type: 'multi-select', color: '#3b82f6', options: ['bug', 'ui'] },
    ];

    it('computes uniqueCustomFieldValues across tasks', () => {
      const columns: ColumnType[] = mockColumns.map(col => ({
        ...col,
        tasks: col.tasks.map((task, i) => ({
          ...task,
          meta: i === 0 ? { Severity: 'high' } : i === 1 ? { Severity: 'low' } : null,
        })),
      }));
      const { result } = renderHook(() => useFilters({ columns, customFields }));
      expect(result.current.uniqueCustomFieldValues['cf-1'].sort()).toEqual(['high', 'low']);
    });

    it('flattens multi-select values for the options list', () => {
      const columns: ColumnType[] = mockColumns.map(col => ({
        ...col,
        tasks: col.tasks.map((task, i) => ({
          ...task,
          meta: i === 0 ? { Labels: ['bug', 'ui'] } : i === 1 ? { Labels: 'bug, perf' } : null,
        })),
      }));
      const { result } = renderHook(() => useFilters({ columns, customFields }));
      const values = result.current.uniqueCustomFieldValues['cf-2'];
      expect(values.sort()).toEqual(['bug', 'perf', 'ui']);
    });

    it('returns empty map when no custom fields are provided', () => {
      const { result } = renderHook(() => useFilters({ columns: mockColumns }));
      expect(result.current.uniqueCustomFieldValues).toEqual({});
    });

    it('filters tasks by single-select custom field value', () => {
      const columns: ColumnType[] = mockColumns.map(col => ({
        ...col,
        tasks: col.id === 'col-1'
          ? col.tasks.map((task, i) => ({
              ...task,
              meta: i === 0 ? { Severity: 'high' } : i === 1 ? { Severity: 'low' } : null,
            }))
          : col.tasks.map(task => ({ ...task, meta: null })),
      }));
      const { result } = renderHook(() => useFilters({ columns, customFields }));
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: { fieldId: 'cf-1', value: 'high' } });
      });
      const filtered = result.current.getFilteredColumns();
      const allTasks = filtered.flatMap(c => c.tasks);
      expect(allTasks.length).toBe(1);
      expect((allTasks[0].meta as Record<string, unknown>).Severity).toBe('high');
    });

    it('filters tasks by multi-select custom field value (array form)', () => {
      const columns: ColumnType[] = mockColumns.map(col => ({
        ...col,
        tasks: col.id === 'col-1'
          ? col.tasks.map((task, i) => ({
              ...task,
              meta: i === 0 ? { Labels: ['bug', 'ui'] } : i === 1 ? { Labels: ['perf'] } : null,
            }))
          : col.tasks.map(task => ({ ...task, meta: null })),
      }));
      const { result } = renderHook(() => useFilters({ columns, customFields }));
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: { fieldId: 'cf-2', value: 'bug' } });
      });
      const filtered = result.current.getFilteredColumns();
      const allTasks = filtered.flatMap(c => c.tasks);
      expect(allTasks.length).toBe(1);
      expect((allTasks[0].meta as Record<string, unknown>).Labels).toEqual(['bug', 'ui']);
    });

    it('excludes tasks that do not carry the filtered custom field', () => {
      const columns: ColumnType[] = mockColumns.map(col => ({
        ...col,
        tasks: col.tasks.map((task, i) => ({
          ...task,
          meta: i === 0 ? { Severity: 'high' } : null,
        })),
      }));
      const { result } = renderHook(() => useFilters({ columns, customFields }));
      act(() => {
        result.current.setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: { fieldId: 'cf-1', value: 'high' } });
      });
      const filtered = result.current.getFilteredColumns();
      const allTasks = filtered.flatMap(c => c.tasks);
      expect(allTasks.every(t => t.meta && (t.meta as Record<string, unknown>).Severity === 'high')).toBe(true);
    });
  });
});