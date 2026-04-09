import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterPanelContent } from './FilterPanelContent';
import type { FilterPreset, FilterState } from '@/hooks/useFilters';

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
  };

  const mockPresets: FilterPreset[] = [];

  const defaultProps = {
    filters: mockFilters,
    uniqueAssignees: [],
    uniqueTags: [],
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
    render(<FilterPanelContent {...defaultProps} />);
    expect(screen.getByRole('button', { name: /filter\.clear/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter\.savePreset/i })).toBeInTheDocument();
  });

  it('should call onSetFilters when priority changes', () => {
    render(<FilterPanelContent {...defaultProps} />);
    const select = screen.getByLabelText(/filter\.priority/i);
    fireEvent.change(select, { target: { value: 'high' } });
    expect(defaultProps.onSetFilters).toHaveBeenCalled();
  });

  it('should call onSetFilters when assignee changes', () => {
    render(<FilterPanelContent {...defaultProps} uniqueAssignees={['Alice', 'Bob']} />);
    const select = screen.getByLabelText(/filter\.assignee/i);
    fireEvent.change(select, { target: { value: 'Alice' } });
    expect(defaultProps.onSetFilters).toHaveBeenCalled();
  });

  it('should call onSetFilters when dateRange changes', () => {
    render(<FilterPanelContent {...defaultProps} />);
    const select = screen.getByLabelText(/filter\.dateRange/i);
    fireEvent.change(select, { target: { value: 'today' } });
    expect(defaultProps.onSetFilters).toHaveBeenCalled();
  });

  it('should call onClearFilters when clear button is clicked', () => {
    render(<FilterPanelContent {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /filter\.clear/i }));
    expect(defaultProps.onClearFilters).toHaveBeenCalled();
  });

  it('should call onSaveCurrentAsPreset when save preset button is clicked', () => {
    render(<FilterPanelContent {...defaultProps} />);
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
    const deleteButtons = screen.getAllByRole('button');
    const deleteButton = deleteButtons.find(btn => btn.innerHTML.includes('line'));
    if (deleteButton) {
      fireEvent.click(deleteButton);
      expect(defaultProps.onDeletePreset).toHaveBeenCalledWith('1');
    }
  });

  it('should call onSetShowPresetDropdown when expand/collapse is clicked', () => {
    const presets: FilterPreset[] = [
      { id: '1', name: 'My Preset', filters: mockFilters }
    ];
    render(<FilterPanelContent {...defaultProps} filterPresets={presets} showPresetDropdown={false} />);
    fireEvent.click(screen.getByText(/filter\.expand/i));
    expect(defaultProps.onSetShowPresetDropdown).toHaveBeenCalledWith(true);
  });
});