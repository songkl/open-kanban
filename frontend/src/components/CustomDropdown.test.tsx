import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CustomDropdown } from './CustomDropdown';

describe('CustomDropdown', () => {
  const options = [
    { value: 'opt1', label: 'Option 1' },
    { value: 'opt2', label: 'Option 2' },
    { value: 'opt3', label: 'Option 3' },
  ];

  const defaultProps = {
    value: '',
    options,
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render with placeholder when no value is selected', () => {
    render(<CustomDropdown {...defaultProps} placeholder="Select an option" />);
    expect(screen.getByText('Select an option')).toBeInTheDocument();
  });

  it('should render with selected option label when value is set', () => {
    render(<CustomDropdown {...defaultProps} value="opt1" />);
    expect(screen.getByText('Option 1')).toBeInTheDocument();
  });

  it('should open dropdown when clicked', () => {
    render(<CustomDropdown {...defaultProps} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('should show all options when open', () => {
    render(<CustomDropdown {...defaultProps} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Option 1')).toBeInTheDocument();
    expect(screen.getByText('Option 2')).toBeInTheDocument();
    expect(screen.getByText('Option 3')).toBeInTheDocument();
  });

  it('should call onChange when option is selected', () => {
    render(<CustomDropdown {...defaultProps} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Option 2'));
    expect(defaultProps.onChange).toHaveBeenCalledWith('opt2');
  });

  it('should close dropdown after selection', () => {
    render(<CustomDropdown {...defaultProps} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Option 2'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('should not open when disabled', () => {
    render(<CustomDropdown {...defaultProps} disabled={true} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('should apply disabled styling when disabled', () => {
    render(<CustomDropdown {...defaultProps} disabled={true} />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
  });

  it('should apply custom className', () => {
    const { container } = render(<CustomDropdown {...defaultProps} className="custom-class" />);
    expect(container.firstChild).toHaveClass('custom-class');
  });
});