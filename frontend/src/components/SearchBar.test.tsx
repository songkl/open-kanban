import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchBar } from './SearchBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'filter.searchPlaceholder') return 'Search...';
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
});