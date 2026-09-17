import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BoardToolbar } from './BoardToolbar';
import type { FilterPreset, FilterState } from '@/hooks/useFilters';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('BoardToolbar', () => {
  const mockFilters: FilterState = {
    priority: '',
    assignee: '',
    searchQuery: '',
    dateRange: '',
    tag: '',
  };

  const mockPresets: FilterPreset[] = [];

  const defaultProps = {
    searchQuery: '',
    filters: mockFilters,
    filterPresets: mockPresets,
    uniqueAssignees: [],
    uniqueTags: [],
    hasActiveFilters: false,
    showFilterPanel: false,
    showPresetDropdown: false,
    onSetSearchQuery: vi.fn(),
    onSetFilters: vi.fn(),
    onClearFilters: vi.fn(),
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
    render(<BoardToolbar {...defaultProps} hasActiveFilters={true} filters={{ ...mockFilters, priority: 'high' }} />);
    expect(screen.getByText('1')).toBeInTheDocument();
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
});