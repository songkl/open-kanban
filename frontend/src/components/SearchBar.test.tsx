import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchBar } from './SearchBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'filter.searchPlaceholder') return 'Search...';
      if (key === 'filter.clearSearch') return 'Clear search';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('SearchBar', () => {
  it('renders with empty value', () => {
    render(<SearchBar value="" onChange={vi.fn()} onClear={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search...');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('renders with a value', () => {
    render(<SearchBar value="test query" onChange={vi.fn()} onClear={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search...');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('test query');
  });

  it('calls onChange when typing', () => {
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} onClear={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search...');
    fireEvent.change(input, { target: { value: 'new query' } });
    expect(onChange).toHaveBeenCalledWith('new query');
  });

  it('shows clear button when value is not empty', () => {
    render(<SearchBar value="test" onChange={vi.fn()} onClear={vi.fn()} />);
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(1);
  });

  it('hides clear button when value is empty', () => {
    render(<SearchBar value="" onChange={vi.fn()} onClear={vi.fn()} />);
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
  });

  it('calls onClear when clear button is clicked', () => {
    const onClear = vi.fn();
    render(<SearchBar value="test" onChange={vi.fn()} onClear={onClear} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(onClear).toHaveBeenCalled();
  });

  it('exposes an accessible label on the search input', () => {
    render(<SearchBar value="" onChange={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByLabelText('Search...')).toBeInTheDocument();
  });

  describe('mobile mode (s-1192)', () => {
    it('renders a full-width input on mobile', () => {
      const { container } = render(<SearchBar value="" onChange={vi.fn()} onClear={vi.fn()} isMobile={true} />);
      const input = screen.getByPlaceholderText('Search...');
      expect(input).toHaveClass('w-full');
      expect(container.querySelector('div.relative.flex.items-center.w-full')).toBeInTheDocument();
    });

    it('hides the clear button on mobile when value is empty', () => {
      render(<SearchBar value="" onChange={vi.fn()} onClear={vi.fn()} isMobile={true} />);
      expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    });

    it('shows an accessible clear button on mobile when value is not empty', () => {
      render(<SearchBar value="hello" onChange={vi.fn()} onClear={vi.fn()} isMobile={true} />);
      const clearButton = screen.getByRole('button', { name: 'Clear search' });
      expect(clearButton).toBeInTheDocument();
    });

    it('calls onClear when the mobile clear button is clicked', () => {
      const onClear = vi.fn();
      render(<SearchBar value="hello" onChange={vi.fn()} onClear={onClear} isMobile={true} />);
      fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
      expect(onClear).toHaveBeenCalledTimes(1);
    });
  });
});