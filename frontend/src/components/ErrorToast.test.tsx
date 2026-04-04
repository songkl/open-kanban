import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorToastContainer } from './ErrorToast';

describe('ErrorToastContainer', () => {
  it('renders nothing when there are no toasts', () => {
    render(<ErrorToastContainer />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders correctly with empty state', () => {
    const { container } = render(<ErrorToastContainer />);
    expect(container.firstChild).toBeNull();
  });
});