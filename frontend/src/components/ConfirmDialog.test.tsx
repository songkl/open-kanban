import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    title: 'Confirm Delete',
    message: 'Are you sure you want to delete this item?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when isOpen is true', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('Confirm Delete')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete this item?')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(<ConfirmDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Confirm Delete')).not.toBeInTheDocument();
  });

  it('renders confirm and cancel buttons', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByRole('button', { name: /task.confirm/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /task.cancel/i })).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button is clicked', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /task.confirm/i }));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button is clicked', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /task.cancel/i }));
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape key is pressed', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not call onConfirm when cancel is clicked', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /task.cancel/i }));
    expect(defaultProps.onConfirm).not.toHaveBeenCalled();
  });

  it('does not call onCancel when confirm is clicked', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /task.confirm/i }));
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });

  it('renders with custom confirmText', () => {
    render(<ConfirmDialog {...defaultProps} confirmText="Delete Now" />);
    expect(screen.getByText('Delete Now')).toBeInTheDocument();
  });

  it('renders with custom cancelText', () => {
    render(<ConfirmDialog {...defaultProps} cancelText="Keep It" />);
    expect(screen.getByText('Keep It')).toBeInTheDocument();
  });

  it('does not call onCancel when clicking inside dialog content', () => {
    render(<ConfirmDialog {...defaultProps} />);
    const dialogContent = screen.getByText('Are you sure you want to delete this item?');
    fireEvent.click(dialogContent);
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });

  it('renders danger variant with warning icon', () => {
    render(<ConfirmDialog {...defaultProps} variant="danger" />);
    const svgElement = document.querySelector('svg');
    expect(svgElement).toBeInTheDocument();
  });

  it('renders with different variants', () => {
    const { rerender } = render(<ConfirmDialog {...defaultProps} variant="default" />);
    expect(screen.getByRole('button', { name: /task.confirm/i })).toBeInTheDocument();

    rerender(<ConfirmDialog {...defaultProps} variant="warning" />);
    expect(screen.getByRole('button', { name: /task.confirm/i })).toBeInTheDocument();

    rerender(<ConfirmDialog {...defaultProps} variant="danger" />);
    expect(screen.getByRole('button', { name: /task.confirm/i })).toBeInTheDocument();
  });
});