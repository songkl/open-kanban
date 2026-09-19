import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ErrorToastContainer, showErrorToast } from './ErrorToast';

describe('ErrorToastContainer', () => {
  it('renders nothing when there are no toasts', () => {
    render(<ErrorToastContainer />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders correctly with empty state', () => {
    const { container } = render(<ErrorToastContainer />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an alert when showErrorToast is invoked', () => {
    render(<ErrorToastContainer />);
    act(() => {
      showErrorToast('Something went wrong', 'error');
    });
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('positions the toast container below the header toolbar to avoid overlap', () => {
    const { container } = render(<ErrorToastContainer />);
    act(() => {
      showErrorToast('Overlap check', 'warning');
    });
    const root = container.querySelector('div.fixed');
    expect(root).not.toBeNull();
    // Header toolbar lives at top-4 (1rem). Toasts must sit below it.
    expect(root!.className).toMatch(/\btop-(16|20|24)\b/);
    // And remain in the top-right corner.
    expect(root!.className).toMatch(/\bright-4\b/);
  });
});