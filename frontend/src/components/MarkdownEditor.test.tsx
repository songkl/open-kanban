import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MarkdownEditor from './MarkdownEditor';

describe('MarkdownEditor', () => {
  const defaultProps = {
    value: '',
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render textarea', () => {
    render(<MarkdownEditor {...defaultProps} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('should render with custom height', () => {
    render(<MarkdownEditor {...defaultProps} height={300} />);
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveStyle({ height: '300px' });
  });

  it('should render with placeholder', () => {
    render(<MarkdownEditor {...defaultProps} placeholder="Enter text..." />);
    expect(screen.getByPlaceholderText('Enter text...')).toBeInTheDocument();
  });

  it('should render with aria-label', () => {
    render(<MarkdownEditor {...defaultProps} aria-label="Description" />);
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
  });

  it('should display value', () => {
    render(<MarkdownEditor {...defaultProps} value="Hello world" />);
    expect(screen.getByRole('textbox')).toHaveValue('Hello world');
  });

  it('should call onChange when text changes', () => {
    render(<MarkdownEditor {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'New text' } });
    expect(defaultProps.onChange).toHaveBeenCalledWith('New text');
  });

  it('should handle Tab key to prevent focus change', () => {
    render(<MarkdownEditor {...defaultProps} value="Hello" />);
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(defaultProps.onChange).toHaveBeenCalled();
  });
});