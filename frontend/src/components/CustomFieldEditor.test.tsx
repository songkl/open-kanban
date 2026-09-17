import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomFieldEditor } from './CustomFieldEditor';
import type { CustomField } from '@/types/kanban';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const fields: CustomField[] = [
  { id: 'a', name: 'Title', type: 'text', color: '#3b82f6' },
  { id: 'b', name: 'Estimate', type: 'number', color: '#22c55e' },
  { id: 'c', name: 'Due', type: 'date', color: '#f59e0b' },
  { id: 'd', name: 'Owner', type: 'single-select', color: '#ef4444', options: ['alice', 'bob'] },
  { id: 'e', name: 'Labels', type: 'multi-select', color: '#8b5cf6', options: ['bug', 'ui'] },
];

describe('CustomFieldEditor', () => {
  it('renders nothing when no fields are defined', () => {
    const { container } = render(
      <CustomFieldEditor customFields={[]} values={{}} onChange={() => {}} isEditing={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders text input for text fields', () => {
    render(
      <CustomFieldEditor customFields={[fields[0]]} values={{ Title: 'hi' }} onChange={() => {}} isEditing={true} />,
    );
    expect(screen.getByTestId('cf-input-a')).toHaveValue('hi');
  });

  it('renders number input for number fields', () => {
    render(
      <CustomFieldEditor customFields={[fields[1]]} values={{ Estimate: 5 }} onChange={() => {}} isEditing={true} />,
    );
    const input = screen.getByTestId('cf-input-b');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveValue(5);
  });

  it('renders date input for date fields', () => {
    render(
      <CustomFieldEditor customFields={[fields[2]]} values={{ Due: '2026-01-01' }} onChange={() => {}} isEditing={true} />,
    );
    const input = screen.getByTestId('cf-input-c');
    expect(input).toHaveAttribute('type', 'date');
    expect(input).toHaveValue('2026-01-01');
  });

  it('renders single-select dropdown', () => {
    render(
      <CustomFieldEditor customFields={[fields[3]]} values={{ Owner: 'alice' }} onChange={() => {}} isEditing={true} />,
    );
    const select = screen.getByTestId('cf-input-d');
    expect(select).toHaveValue('alice');
  });

  it('renders multi-select toggle chips', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CustomFieldEditor customFields={[fields[4]]} values={{ Labels: [] }} onChange={onChange} isEditing={true} />,
    );
    expect(screen.getByTestId('cf-chip-e-bug')).toBeInTheDocument();
    await user.click(screen.getByTestId('cf-chip-e-bug'));
    expect(onChange).toHaveBeenCalledWith({ Labels: ['bug'] });
  });

  it('shows read-only display values when not editing', () => {
    render(
      <CustomFieldEditor customFields={[fields[0]]} values={{ Title: 'preview' }} onChange={() => {}} isEditing={false} />,
    );
    expect(screen.getByTestId('cf-view-a')).toHaveTextContent('preview');
  });

  it('shows placeholder dash when not editing and value is empty', () => {
    render(
      <CustomFieldEditor customFields={[fields[0]]} values={{}} onChange={() => {}} isEditing={false} />,
    );
    expect(screen.getByTestId('cf-view-a')).toHaveTextContent('—');
  });

  it('formats multi-select display values', () => {
    render(
      <CustomFieldEditor customFields={[fields[4]]} values={{ Labels: ['bug', 'ui'] }} onChange={() => {}} isEditing={false} />,
    );
    expect(screen.getByTestId('cf-view-e')).toHaveTextContent('bug, ui');
  });

  it('formats dates as YYYY-MM-DD in view mode', () => {
    render(
      <CustomFieldEditor customFields={[fields[2]]} values={{ Due: '2026-01-01T10:00:00Z' }} onChange={() => {}} isEditing={false} />,
    );
    expect(screen.getByTestId('cf-view-c')).toHaveTextContent('2026-01-01');
  });

  it('fires onChange with a copy of values when a text field is edited', () => {
    const onChange = vi.fn();
    render(
      <CustomFieldEditor customFields={[fields[0]]} values={{ Title: 'old' }} onChange={onChange} isEditing={true} />,
    );
    fireEvent.change(screen.getByTestId('cf-input-a'), { target: { value: 'new' } });
    expect(onChange).toHaveBeenCalledWith({ Title: 'new' });
  });

  it('removes the key when an empty value is committed', () => {
    const onChange = vi.fn();
    render(
      <CustomFieldEditor customFields={[fields[0]]} values={{ Title: 'old' }} onChange={onChange} isEditing={true} />,
    );
    fireEvent.change(screen.getByTestId('cf-input-a'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({});
  });
});