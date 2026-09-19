import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomFieldChips } from './CustomFieldChips';
import type { CustomField } from '@/types/kanban';

const fields: CustomField[] = [
  { id: 'a', name: 'Severity', type: 'single-select', color: '#ef4444', options: ['low', 'high'] },
  { id: 'b', name: 'Estimate', type: 'number', color: '#22c55e' },
  { id: 'c', name: 'Tags', type: 'multi-select', color: '#3b82f6', options: ['bug', 'ui'] },
  { id: 'd', name: 'Due', type: 'date', color: '#f59e0b' },
];

describe('CustomFieldChips', () => {
  it('returns null when meta is empty', () => {
    const { container } = render(<CustomFieldChips meta={null} customFields={fields} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when no fields are defined', () => {
    const { container } = render(<CustomFieldChips meta={{ Severity: 'low' }} customFields={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a chip for each defined field with a value', () => {
    render(
      <CustomFieldChips
        meta={{ Severity: 'low', Estimate: 4, Tags: ['bug', 'ui'], Due: '2026-01-01T00:00:00Z', Unrelated: 'x' }}
        customFields={fields}
      />,
    );
    expect(screen.getByTestId('custom-field-chip-a')).toBeInTheDocument();
    expect(screen.getByTestId('custom-field-chip-b')).toBeInTheDocument();
    expect(screen.getByTestId('custom-field-chip-c')).toBeInTheDocument();
    expect(screen.getByTestId('custom-field-chip-d')).toBeInTheDocument();
  });

  it('skips fields with empty or missing values', () => {
    render(
      <CustomFieldChips
        meta={{ Severity: '', Estimate: null }}
        customFields={fields}
      />,
    );
    expect(screen.queryByTestId('custom-field-chip-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('custom-field-chip-b')).not.toBeInTheDocument();
  });

  it('formats multi-select values as comma-separated', () => {
    render(
      <CustomFieldChips meta={{ Tags: ['bug', 'ui'] }} customFields={fields} />,
    );
    expect(screen.getByTestId('custom-field-chip-c')).toHaveTextContent('bug, ui');
  });

  it('parses legacy CSV-formatted multi-select values', () => {
    render(
      <CustomFieldChips meta={{ Tags: 'bug, ui' }} customFields={fields} />,
    );
    expect(screen.getByTestId('custom-field-chip-c')).toHaveTextContent('bug, ui');
  });

  it('formats dates as YYYY-MM-DD', () => {
    render(
      <CustomFieldChips meta={{ Due: '2026-01-01T10:00:00Z' }} customFields={fields} />,
    );
    expect(screen.getByTestId('custom-field-chip-d')).toHaveTextContent('2026-01-01');
  });

  it('shows an overflow indicator when more than maxVisible chips match', () => {
    const manyFields: CustomField[] = [
      ...fields,
      { id: 'e', name: 'A', type: 'text', color: '#111' },
      { id: 'f', name: 'B', type: 'text', color: '#222' },
      { id: 'g', name: 'C', type: 'text', color: '#333' },
      { id: 'h', name: 'D', type: 'text', color: '#444' },
    ];
    render(
      <CustomFieldChips
        meta={{ Severity: 'low', Estimate: 4, Tags: ['bug'], Due: '2026-01-01', A: '1', B: '2', C: '3', D: '4' }}
        customFields={manyFields}
        maxVisible={3}
      />,
    );
    expect(screen.getByText('+5')).toBeInTheDocument();
  });
});