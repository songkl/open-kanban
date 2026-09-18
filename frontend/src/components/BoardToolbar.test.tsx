import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BoardToolbar } from './BoardToolbar';
import { EMPTY_CUSTOM_FIELD_FILTER, type FilterPreset, type FilterState } from '@/hooks/useFilters';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'filter.appliedCount' && params) {
        return `${params.count} filters applied`;
      }
      return key;
    },
  }),
}));

describe('BoardToolbar', () => {
  const mockFilters: FilterState = {
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

  const mockPresets: FilterPreset[] = [];

  const defaultProps = {
    searchQuery: '',
    filters: mockFilters,
    filterPresets: mockPresets,
    uniqueAssignees: [],
    uniqueTags: [],
    uniqueCustomFieldValues: {},
    customFields: [],
    hasActiveFilters: false,
    activeFilterCount: 0,
    showFilterPanel: false,
    showPresetDropdown: false,
    onSetSearchQuery: vi.fn(),
    onSetFilters: vi.fn(),
    onClearFilters: vi.fn(),
    onClearSingleFilter: vi.fn(),
    onSaveCurrentAsPreset: vi.fn(),
    onApplyPreset: vi.fn(),
    onDeletePreset: vi.fn(),
    onSetShowPresetDropdown: vi.fn(),
    onToggleFilterPanel: vi.fn(),
    onCloseFilterPanel: vi.fn(),
    onAddTask: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render search bar and buttons', () => {
    render(<BoardToolbar {...defaultProps} />);
    expect(screen.getByRole('button', { name: /filter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /task\.create/i })).toBeInTheDocument();
  });

  it('should call onToggleFilterPanel when filter button is clicked', () => {
    render(<BoardToolbar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    expect(defaultProps.onToggleFilterPanel).toHaveBeenCalled();
  });

  it('should call onAddTask when add task button is clicked', () => {
    render(<BoardToolbar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /task\.create/i }));
    expect(defaultProps.onAddTask).toHaveBeenCalled();
  });

  it('should show filter count badge when hasActiveFilters is true', () => {
    const { container } = render(<BoardToolbar {...defaultProps} hasActiveFilters={true} activeFilterCount={1} filters={{ ...mockFilters, priority: 'high' }} />);
    const badge = container.querySelector('span.rounded-full.bg-blue-500');
    expect(badge?.textContent).toBe('1');
  });

  it('should show filter panel when showFilterPanel is true', () => {
    render(<BoardToolbar {...defaultProps} showFilterPanel={true} />);
    expect(screen.getByLabelText(/filter\.priority/i)).toBeInTheDocument();
  });

  it('should apply active filter styling when hasActiveFilters is true', () => {
    const { container } = render(<BoardToolbar {...defaultProps} hasActiveFilters={true} filters={{ ...mockFilters, priority: 'high' }} />);
    const button = container.querySelector('button');
    expect(button?.className).toContain('bg-blue-100');
  });

  describe('create-task permission gating (s-1053)', () => {
    it('enables the create button when canCreateTask is true', () => {
      render(<BoardToolbar {...defaultProps} canCreateTask={true} />);
      const createButton = screen.getByRole('button', { name: /task\.create/i });
      expect(createButton).not.toBeDisabled();
    });

    it('disables the create button when canCreateTask is false', () => {
      render(<BoardToolbar {...defaultProps} canCreateTask={false} />);
      const createButton = screen.getByRole('button', { name: /task\.create/i });
      expect(createButton).toBeDisabled();
      expect(createButton).toHaveAttribute('title', 'task.createNoPermission');
    });

    it('does not call onAddTask when disabled button is clicked', () => {
      render(<BoardToolbar {...defaultProps} canCreateTask={false} />);
      const createButton = screen.getByRole('button', { name: /task\.create/i });
      fireEvent.click(createButton);
      expect(defaultProps.onAddTask).not.toHaveBeenCalled();
    });

    it('defaults canCreateTask to enabled when prop is omitted', () => {
      render(<BoardToolbar {...defaultProps} />);
      const createButton = screen.getByRole('button', { name: /task\.create/i });
      expect(createButton).not.toBeDisabled();
    });
  });

  describe('mobile layout (s-1192)', () => {
    it('uses an icon-only filter button on mobile', () => {
      render(<BoardToolbar {...defaultProps} isMobile={true} />);
      const filterButton = screen.getByRole('button', { name: /filter/i });
      expect(filterButton).toBeInTheDocument();
      expect(filterButton.className).toContain('min-h-[36px]');
      expect(filterButton.className).toContain('min-w-[36px]');
    });

    it('hides the inline "Filter" label on mobile via hidden class', () => {
      render(<BoardToolbar {...defaultProps} isMobile={true} />);
      const label = screen.getByText('filter.filter');
      expect(label.className).toContain('hidden');
      expect(label.className).toContain('sm:inline');
    });

    it('keeps the inline "Filter" label visible on desktop', () => {
      render(<BoardToolbar {...defaultProps} isMobile={false} />);
      const label = screen.getByText('filter.filter');
      expect(label.className).toContain('sm:inline');
    });

    it('uses an icon-only create button on mobile', () => {
      render(<BoardToolbar {...defaultProps} isMobile={true} />);
      const createButton = screen.getByRole('button', { name: /task\.create/i });
      expect(createButton.className).toContain('min-h-[36px]');
      expect(createButton.className).toContain('min-w-[36px]');
      const inlineLabel = createButton.querySelector('.hidden.sm\\:inline');
      expect(inlineLabel).toBeInTheDocument();
      expect(inlineLabel?.textContent).toBe('task.create');
    });

    it('renders a SearchBar in mobile mode (full width)', () => {
      const { container } = render(<BoardToolbar {...defaultProps} isMobile={true} />);
      const mobileSearch = container.querySelector('input.w-full.min-h-\\[36px\\]');
      expect(mobileSearch).toBeInTheDocument();
    });
  });

  describe('applied-filter chips (s-1201)', () => {
    it('does not render chips when no filter is active', () => {
      const { container } = render(<BoardToolbar {...defaultProps} hasActiveFilters={false} />);
      expect(container.querySelector('[data-testid="applied-filter-chips"]')).toBeNull();
    });

    it('renders the "N filters applied" chip when at least one filter is active', () => {
      const { container } = render(
        <BoardToolbar
          {...defaultProps}
          hasActiveFilters={true}
          activeFilterCount={3}
          filters={{ ...mockFilters, priority: 'high', assignee: 'Alice', runStatus: 'running' }}
        />,
      );
      const chips = container.querySelector('[data-testid="applied-filter-chips"]');
      expect(chips).toBeInTheDocument();
      expect(chips?.textContent).toContain('3');
    });

    it('renders one chip per active dimension with × buttons', () => {
      const { container } = render(
        <BoardToolbar
          {...defaultProps}
          hasActiveFilters={true}
          activeFilterCount={2}
          filters={{ ...mockFilters, priority: 'high', assignee: 'Alice' }}
        />,
      );
      const removeButtons = container.querySelectorAll('[data-testid="applied-filter-chips"] button[aria-label^="filter.removeFilter"]');
      expect(removeButtons.length).toBe(2);
    });

    it('calls onClearSingleFilter with the right dimension when a chip × is clicked', () => {
      const onClearSingleFilter = vi.fn();
      const { container } = render(
        <BoardToolbar
          {...defaultProps}
          hasActiveFilters={true}
          activeFilterCount={1}
          filters={{ ...mockFilters, priority: 'high' }}
          onClearSingleFilter={onClearSingleFilter}
        />,
      );
      const removeButton = container.querySelector('button[aria-label^="filter.removeFilter"]') as HTMLButtonElement;
      fireEvent.click(removeButton);
      expect(onClearSingleFilter).toHaveBeenCalledWith('priority');
    });

    it('calls onClearFilters when the aggregate "N filters applied" chip is clicked', () => {
      const onClearFilters = vi.fn();
      const { container } = render(
        <BoardToolbar
          {...defaultProps}
          hasActiveFilters={true}
          activeFilterCount={2}
          filters={{ ...mockFilters, priority: 'high', assignee: 'Alice' }}
          onClearFilters={onClearFilters}
        />,
      );
      const aggregate = container.querySelector('button[title="filter.clearAll"]') as HTMLButtonElement;
      expect(aggregate).toBeTruthy();
      fireEvent.click(aggregate);
      expect(onClearFilters).toHaveBeenCalled();
    });

    it('renders chips even when the filter panel is closed', () => {
      const { container } = render(
        <BoardToolbar
          {...defaultProps}
          hasActiveFilters={true}
          activeFilterCount={1}
          showFilterPanel={false}
          filters={{ ...mockFilters, runStatus: 'running' }}
        />,
      );
      expect(container.querySelector('[data-testid="applied-filter-chips"]')).toBeInTheDocument();
    });
  });

  // s-1213: card density toggle (PM-s1188 §3.3). The selector is
  // gated behind `onSetDensity` so older callers (and tests) keep
  // working unchanged.
  describe('card density selector (s-1213)', () => {
    it('does not render the density selector when onSetDensity is omitted', () => {
      const { container } = render(<BoardToolbar {...defaultProps} />);
      expect(container.querySelector('[data-testid="board-density-selector"]')).toBeNull();
    });

    it('renders a radiogroup with three options when onSetDensity is provided', () => {
      const { container } = render(
        <BoardToolbar {...defaultProps} density="standard" onSetDensity={vi.fn()} />,
      );
      const group = container.querySelector('[data-testid="board-density-selector"]');
      expect(group).toBeInTheDocument();
      expect(group?.getAttribute('role')).toBe('radiogroup');
      expect(container.querySelector('[data-testid="board-density-compact"]')).toBeInTheDocument();
      expect(container.querySelector('[data-testid="board-density-standard"]')).toBeInTheDocument();
      expect(container.querySelector('[data-testid="board-density-detailed"]')).toBeInTheDocument();
    });

    it('marks the active density via aria-checked', () => {
      const { container } = render(
        <BoardToolbar {...defaultProps} density="compact" onSetDensity={vi.fn()} />,
      );
      const compact = container.querySelector('[data-testid="board-density-compact"]') as HTMLButtonElement;
      const standard = container.querySelector('[data-testid="board-density-standard"]') as HTMLButtonElement;
      const detailed = container.querySelector('[data-testid="board-density-detailed"]') as HTMLButtonElement;
      expect(compact.getAttribute('aria-checked')).toBe('true');
      expect(standard.getAttribute('aria-checked')).toBe('false');
      expect(detailed.getAttribute('aria-checked')).toBe('false');
    });

    it('calls onSetDensity with the new value when an option is clicked', () => {
      const onSetDensity = vi.fn();
      const { container } = render(
        <BoardToolbar {...defaultProps} density="standard" onSetDensity={onSetDensity} />,
      );
      const compact = container.querySelector('[data-testid="board-density-compact"]') as HTMLButtonElement;
      fireEvent.click(compact);
      expect(onSetDensity).toHaveBeenCalledWith('compact');
    });

    it('does not call onSetDensity when the already-active option is clicked', () => {
      const onSetDensity = vi.fn();
      const { container } = render(
        <BoardToolbar {...defaultProps} density="standard" onSetDensity={onSetDensity} />,
      );
      const standard = container.querySelector('[data-testid="board-density-standard"]') as HTMLButtonElement;
      fireEvent.click(standard);
      expect(onSetDensity).not.toHaveBeenCalled();
    });
  });
});