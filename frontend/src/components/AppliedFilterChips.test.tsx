import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppliedFilterChips } from './AppliedFilterChips';
import { EMPTY_CUSTOM_FIELD_FILTER, type FilterState } from '@/hooks/useFilters';
import type { CustomField } from '@/types/kanban';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'filter.appliedCount' && params) {
        const count = params.count as number;
        return `${count} filters applied`;
      }
      return key;
    },
  }),
}));

const emptyFilters: FilterState = {
  priority: '',
  assignee: '',
  searchQuery: '',
  dateRange: '',
  tag: '',
  customField: EMPTY_CUSTOM_FIELD_FILTER,
  runStatus: '',
  hasComments: '',
  hasSubtasks: '',
};

const customFields: CustomField[] = [
  { id: 'cf-1', name: 'Severity', type: 'single-select', color: '#ef4444', options: ['low', 'high'] },
];

describe('AppliedFilterChips', () => {
  it('renders nothing when no filter is active', () => {
    const { container } = render(
      <AppliedFilterChips
        filters={emptyFilters}
        customFields={customFields}
        onClearSingleFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the aggregate chip with the count of active filters', () => {
    render(
      <AppliedFilterChips
        filters={{ ...emptyFilters, priority: 'high', assignee: 'Alice' }}
        customFields={customFields}
        onClearSingleFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(screen.getByText('2 filters applied')).toBeInTheDocument();
  });

  it('invokes onClearAll when the aggregate chip is clicked', () => {
    const onClearAll = vi.fn();
    const { container } = render(
      <AppliedFilterChips
        filters={{ ...emptyFilters, priority: 'high' }}
        customFields={customFields}
        onClearSingleFilter={vi.fn()}
        onClearAll={onClearAll}
      />,
    );
    const aggregate = container.querySelector('button[title="filter.clearAll"]') as HTMLButtonElement;
    fireEvent.click(aggregate);
    expect(onClearAll).toHaveBeenCalled();
  });

  it('invokes onClearSingleFilter with the dimension when a chip × is clicked', () => {
    const onClearSingleFilter = vi.fn();
    render(
      <AppliedFilterChips
        filters={{ ...emptyFilters, priority: 'high' }}
        customFields={customFields}
        onClearSingleFilter={onClearSingleFilter}
        onClearAll={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /filter\.removeFilter/i }));
    expect(onClearSingleFilter).toHaveBeenCalledWith('priority');
  });

  it('renders the runStatus chip using translated label', () => {
    render(
      <AppliedFilterChips
        filters={{ ...emptyFilters, runStatus: 'running' }}
        customFields={customFields}
        onClearSingleFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(screen.getByText(/filter\.runStatus: filter\.runStatusRunning/)).toBeInTheDocument();
  });

  it('renders the hasComments and hasSubtasks chips', () => {
    render(
      <AppliedFilterChips
        filters={{ ...emptyFilters, hasComments: 'yes', hasSubtasks: 'no' }}
        customFields={customFields}
        onClearSingleFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(screen.getByText(/filter\.hasComments: filter\.yes/)).toBeInTheDocument();
    expect(screen.getByText(/filter\.hasSubtasks: filter\.no/)).toBeInTheDocument();
  });

  it('renders the customField chip using the field name', () => {
    render(
      <AppliedFilterChips
        filters={{ ...emptyFilters, customField: { fieldId: 'cf-1', value: 'high' } }}
        customFields={customFields}
        onClearSingleFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(screen.getByText(/filter\.customField: Severity/)).toBeInTheDocument();
    expect(screen.getByText(/filter\.customFieldValue: high/)).toBeInTheDocument();
  });

  it('falls back to the fieldId when the customField definition cannot be resolved', () => {
    render(
      <AppliedFilterChips
        filters={{ ...emptyFilters, customField: { fieldId: 'cf-unknown', value: '' } }}
        customFields={[]}
        onClearSingleFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(screen.getByText(/filter\.customField: cf-unknown/)).toBeInTheDocument();
  });
});
