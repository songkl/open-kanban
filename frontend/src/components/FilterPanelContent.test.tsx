import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterPanelContent } from './FilterPanelContent';
import { EMPTY_CUSTOM_FIELD_FILTER, type FilterPreset, type FilterState } from '@/hooks/useFilters';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('FilterPanelContent', () => {
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
    filters: mockFilters,
    uniqueAssignees: [],
    uniqueTags: [],
    uniqueCustomFieldValues: {},
    customFields: [],
    filterPresets: mockPresets,
    showPresetDropdown: false,
    onSetFilters: vi.fn(),
    onClearFilters: vi.fn(),
    onSaveCurrentAsPreset: vi.fn(),
    onApplyPreset: vi.fn(),
    onDeletePreset: vi.fn(),
    onSetShowPresetDropdown: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render priority select', () => {
    render(<FilterPanelContent {...defaultProps} />);
    expect(screen.getByLabelText(/filter\.priority/i)).toBeInTheDocument();
  });

  it('should render assignee select', () => {
    render(<FilterPanelContent {...defaultProps} />);
    expect(screen.getByLabelText(/filter\.assignee/i)).toBeInTheDocument();
  });

  it('should render date range select', () => {
    render(<FilterPanelContent {...defaultProps} />);
    expect(screen.getByLabelText(/filter\.dateRange/i)).toBeInTheDocument();
  });

  it('should render clear and save preset buttons', () => {
    render(
      <FilterPanelContent
        {...defaultProps}
        filterPresets={[{ id: '1', name: 'Existing', filters: mockFilters }]}
      />
    );
    expect(screen.getByRole('button', { name: /filter\.clear/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter\.savePreset/i })).toBeInTheDocument();
  });

  it('should not render save preset button when filterPresets is empty', () => {
    render(<FilterPanelContent {...defaultProps} filterPresets={[]} />);
    expect(screen.getByRole('button', { name: /filter\.clear/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /filter\.savePreset/i })).not.toBeInTheDocument();
  });

  it('should call onSetFilters when priority changes', () => {
    render(<FilterPanelContent {...defaultProps} />);
    fireEvent.click(screen.getByLabelText(/filter\.priority/i));
    fireEvent.click(screen.getByRole('option', { name: /filter\.high/i }));
    expect(defaultProps.onSetFilters).toHaveBeenCalled();
  });

  it('should call onSetFilters when assignee changes', () => {
    render(<FilterPanelContent {...defaultProps} uniqueAssignees={['Alice', 'Bob']} />);
    fireEvent.click(screen.getByLabelText(/filter\.assignee/i));
    fireEvent.click(screen.getByRole('option', { name: 'Alice' }));
    expect(defaultProps.onSetFilters).toHaveBeenCalled();
  });

  it('should call onSetFilters when dateRange changes', () => {
    render(<FilterPanelContent {...defaultProps} />);
    fireEvent.click(screen.getByLabelText(/filter\.dateRange/i));
    fireEvent.click(screen.getByRole('option', { name: /filter\.today/i }));
    expect(defaultProps.onSetFilters).toHaveBeenCalled();
  });

  it('should call onClearFilters when clear button is clicked', () => {
    render(<FilterPanelContent {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /filter\.clear/i }));
    expect(defaultProps.onClearFilters).toHaveBeenCalled();
  });

  it('should call onSaveCurrentAsPreset when save preset button is clicked', () => {
    render(
      <FilterPanelContent
        {...defaultProps}
        filterPresets={[{ id: '1', name: 'Existing', filters: mockFilters }]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /filter\.savePreset/i }));
    expect(defaultProps.onSaveCurrentAsPreset).toHaveBeenCalled();
  });

  it('should show tag select when uniqueTags is not empty', () => {
    render(<FilterPanelContent {...defaultProps} uniqueTags={['bug', 'feature']} />);
    expect(screen.getByLabelText(/filter\.tag/i)).toBeInTheDocument();
  });

  it('should not show tag select when uniqueTags is empty', () => {
    render(<FilterPanelContent {...defaultProps} uniqueTags={[]} />);
    expect(screen.queryByLabelText(/filter\.tag/i)).not.toBeInTheDocument();
  });

  it('should show presets section when filterPresets is not empty and dropdown is open', () => {
    const presets: FilterPreset[] = [
      { id: '1', name: 'My Preset', filters: mockFilters }
    ];
    render(<FilterPanelContent {...defaultProps} filterPresets={presets} showPresetDropdown={true} />);
    expect(screen.getByText('My Preset')).toBeInTheDocument();
  });

  it('should not show presets section when filterPresets is empty', () => {
    render(<FilterPanelContent {...defaultProps} filterPresets={[]} />);
    expect(screen.queryByText(/filter\.preset/i)).not.toBeInTheDocument();
  });

  it('should call onApplyPreset when preset is clicked', () => {
    const presets: FilterPreset[] = [
      { id: '1', name: 'My Preset', filters: { ...mockFilters, priority: 'high' } }
    ];
    render(<FilterPanelContent {...defaultProps} filterPresets={presets} showPresetDropdown={true} />);
    fireEvent.click(screen.getByText('My Preset'));
    expect(defaultProps.onApplyPreset).toHaveBeenCalledWith(presets[0]);
  });

  it('should call onDeletePreset when delete button is clicked', () => {
    const presets: FilterPreset[] = [
      { id: '1', name: 'My Preset', filters: mockFilters }
    ];
    render(<FilterPanelContent {...defaultProps} filterPresets={presets} showPresetDropdown={true} />);
    const presetContainer = screen.getByText('My Preset').parentElement;
    const deleteButton = presetContainer?.querySelector('button:last-child');
    if (deleteButton) {
      fireEvent.click(deleteButton);
      expect(defaultProps.onDeletePreset).toHaveBeenCalledWith('1');
    }
  });

  it('should call onSetShowPresetDropdown when expand/collapse is clicked', () => {
    const presets: FilterPreset[] = [
      { id: '1', name: 'My Preset', filters: { ...mockFilters, priority: 'high' } }
    ];
    render(<FilterPanelContent {...defaultProps} filterPresets={presets} showPresetDropdown={false} />);
    fireEvent.click(screen.getByText(/filter\.expand/i));
    expect(defaultProps.onSetShowPresetDropdown).toHaveBeenCalledWith(true);
  });

  it('should render children when provided', () => {
    render(
      <FilterPanelContent {...defaultProps} hideBoardDefaults>
        <div data-testid="custom-child">Custom Field</div>
      </FilterPanelContent>
    );
    expect(screen.getByTestId('custom-child')).toBeInTheDocument();
    expect(screen.getByText('Custom Field')).toBeInTheDocument();
  });

  it('should hide board-default fields when hideBoardDefaults is true', () => {
    render(<FilterPanelContent {...defaultProps} hideBoardDefaults />);
    expect(screen.queryByLabelText(/filter\.priority/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/filter\.assignee/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/filter\.dateRange/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter\.clear/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /filter\.savePreset/i })).not.toBeInTheDocument();
  });

  it('should still render children after defaults when hideBoardDefaults is false', () => {
    render(
      <FilterPanelContent {...defaultProps}>
        <div data-testid="custom-child">Extra</div>
      </FilterPanelContent>
    );
    expect(screen.getByLabelText(/filter\.priority/i)).toBeInTheDocument();
    expect(screen.getByTestId('custom-child')).toBeInTheDocument();
  });
});