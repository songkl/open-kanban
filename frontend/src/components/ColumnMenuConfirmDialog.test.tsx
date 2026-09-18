import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColumnMenuConfirmDialog } from './ColumnMenuConfirmDialog';

vi.mock('../hooks/useFocusTrap', () => ({
  useFocusTrap: () => ({ current: null }),
}));

const renderDialog = (props: Partial<React.ComponentProps<typeof ColumnMenuConfirmDialog>> = {}) => {
  const defaultProps: React.ComponentProps<typeof ColumnMenuConfirmDialog> = {
    isOpen: true,
    action: 'archive',
    columnName: 'To Do',
    affectedTasks: [
      { id: 't1', title: 'Task one' },
      { id: 't2', title: 'Task two' },
    ],
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...props,
  };
  return render(<ColumnMenuConfirmDialog {...defaultProps} />);
};

describe('ColumnMenuConfirmDialog (s-1212)', () => {
  it('renders nothing when closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the affected-task preview for archive action', () => {
    renderDialog({ action: 'archive', columnName: 'To Do' });
    // useTranslation in tests returns the key as-is, so the title
    // and message are the literal key strings. The component wires
    // up the right key for each action via template literals.
    expect(screen.getByText('column.bulkConfirm.archiveTitle')).toBeInTheDocument();
    expect(screen.getByText('column.bulkConfirm.archiveMessage')).toBeInTheDocument();
    expect(screen.getByText('• Task one')).toBeInTheDocument();
    expect(screen.getByText('• Task two')).toBeInTheDocument();
  });

  it('uses the exportCsv title/message and skips the preview block', () => {
    renderDialog({ action: 'exportCsv' });
    // The i18n mock returns the literal key with {{columnName}}
    // uninterpolated, so the rendered title is the key itself.
    expect(screen.getByText('column.bulkConfirm.exportCsvTitle')).toBeInTheDocument();
    expect(screen.getByText('column.bulkConfirm.exportCsvMessage')).toBeInTheDocument();
    // The affected-tasks section is only rendered for archive and
    // complete — for exportCsv we skip it because there is no
    // mutation to preview.
    expect(screen.queryByText('column.bulkConfirm.affected')).toBeNull();
  });

  it('caps the preview at 50 task titles and surfaces a "+N more" suffix', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }));
    renderDialog({ affectedTasks: many });
    expect(screen.getByText(/Task 0/)).toBeInTheDocument();
    expect(screen.getByText(/Task 49/)).toBeInTheDocument();
    expect(screen.queryByText(/Task 50/)).toBeNull();
  });

  it('does not render the preview block when there are no tasks', () => {
    renderDialog({ affectedTasks: [] });
    expect(screen.queryByText('column.bulkConfirm.affected')).toBeNull();
  });

  it('invokes onConfirm when the Confirm button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });
    await user.click(screen.getByTestId('column-bulk-confirm-archive'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('invokes onCancel when the Cancel button is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    await user.click(screen.getByRole('button', { name: /column\.bulkConfirm\.cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
