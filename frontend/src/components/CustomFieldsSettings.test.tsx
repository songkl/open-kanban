import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomFieldsSettings } from './CustomFieldsSettings';
import type { CustomField } from '@/types/kanban';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseField: CustomField = {
  id: 'f-1',
  name: 'Severity',
  type: 'single-select',
  color: '#3b82f6',
  options: ['low', 'high'],
};

describe('CustomFieldsSettings', () => {
  const defaultProps = {
    isOpen: true,
    customFields: [] as CustomField[],
    onClose: vi.fn(),
    onSave: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<CustomFieldsSettings {...defaultProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the empty state when no fields exist', () => {
    render(<CustomFieldsSettings {...defaultProps} />);
    expect(screen.getByText('customFields.empty')).toBeInTheDocument();
  });

  it('renders existing fields with name and type', () => {
    render(<CustomFieldsSettings {...defaultProps} customFields={[baseField]} />);
    expect(screen.getByDisplayValue('Severity')).toBeInTheDocument();
    const select = screen.getByTestId('custom-field-type-0') as HTMLSelectElement;
    expect(select.value).toBe('single-select');
  });

  it('adds a new field when Add field is clicked', async () => {
    const user = userEvent.setup();
    render(<CustomFieldsSettings {...defaultProps} />);
    await user.click(screen.getByTestId('custom-fields-add'));
    const rows = screen.getAllByTestId(/^custom-field-row-/);
    expect(rows.length).toBe(1);
  });

  it('removes a field when the delete button is clicked', async () => {
    const user = userEvent.setup();
    render(<CustomFieldsSettings {...defaultProps} customFields={[baseField]} />);
    await user.click(screen.getByTestId('custom-field-remove-0'));
    expect(screen.getByText('customFields.empty')).toBeInTheDocument();
  });

  it('saves cleaned fields through onSave', async () => {
    const user = userEvent.setup();
    render(<CustomFieldsSettings {...defaultProps} customFields={[baseField]} />);
    await user.click(screen.getByTestId('custom-fields-save'));
    expect(defaultProps.onSave).toHaveBeenCalledWith([baseField]);
  });

  it('strips empty-named fields on save', async () => {
    const user = userEvent.setup();
    render(<CustomFieldsSettings {...defaultProps} customFields={[{ ...baseField, name: '   ' }]} />);
    await user.click(screen.getByTestId('custom-fields-save'));
    expect(defaultProps.onSave).toHaveBeenCalledWith([]);
  });

  it('shows options editor for single-select fields', () => {
    render(<CustomFieldsSettings {...defaultProps} customFields={[baseField]} />);
    expect(screen.getByDisplayValue('low')).toBeInTheDocument();
    expect(screen.getByDisplayValue('high')).toBeInTheDocument();
  });

  it('hides options editor for text fields', () => {
    render(<CustomFieldsSettings {...defaultProps} customFields={[{ ...baseField, type: 'text', options: undefined }]} />);
    expect(screen.queryByDisplayValue('low')).not.toBeInTheDocument();
  });

  it('changes type and clears options when switching away from select', async () => {
    const user = userEvent.setup();
    render(<CustomFieldsSettings {...defaultProps} customFields={[baseField]} />);
    const select = screen.getByTestId('custom-field-type-0');
    await user.selectOptions(select, 'text');
    // After switching away, no option rows should remain.
    expect(screen.queryByDisplayValue('low')).not.toBeInTheDocument();
  });

  it('calls onClose when the backdrop is clicked', () => {
    render(<CustomFieldsSettings {...defaultProps} />);
    fireEvent.click(screen.getByTestId('custom-fields-settings-backdrop'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when Cancel is clicked', () => {
    render(<CustomFieldsSettings {...defaultProps} />);
    fireEvent.click(screen.getByText('customFields.cancel'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});