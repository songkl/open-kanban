import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoardSkeleton, Spinner, LoadingOverlay, TaskModalSkeleton } from './Skeleton';

describe('BoardSkeleton', () => {
  it('renders board skeleton with header', () => {
    render(<BoardSkeleton />);
    const skeletonElements = document.querySelectorAll('.animate-pulse');
    expect(skeletonElements.length).toBeGreaterThan(0);
  });

  it('renders skeleton with correct structure', () => {
    render(<BoardSkeleton />);
    const skeleton = document.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();
  });

  it('renders multiple columns skeleton', () => {
    render(<BoardSkeleton />);
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(5);
  });
});

describe('Spinner', () => {
  it('renders spinner with default className', () => {
    render(<Spinner />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders spinner with custom className', () => {
    render(<Spinner className="h-10 w-10 text-blue-500" />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
    expect(spinner?.className).toContain('h-10');
    expect(spinner?.className).toContain('w-10');
  });

  it('renders with role status', () => {
    render(<Spinner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders screen reader text', () => {
    render(<Spinner />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});

describe('LoadingOverlay', () => {
  it('renders loading overlay', () => {
    render(<LoadingOverlay />);
    const overlay = document.querySelector('.fixed.inset-0');
    expect(overlay).toBeInTheDocument();
  });

  it('renders with custom message', () => {
    render(<LoadingOverlay message="Saving..." />);
    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('renders without message', () => {
    render(<LoadingOverlay />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders spinner inside overlay', () => {
    render(<LoadingOverlay />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders with correct structure', () => {
    render(<LoadingOverlay message="Loading data..." />);
    expect(screen.getByText('Loading data...')).toBeInTheDocument();
  });
});

describe('TaskModalSkeleton', () => {
  it('renders skeleton with test id', () => {
    render(<TaskModalSkeleton />);
    expect(screen.getByTestId('task-modal-skeleton')).toBeInTheDocument();
  });

  it('renders skeleton as a fixed overlay', () => {
    render(<TaskModalSkeleton />);
    const skeleton = screen.getByTestId('task-modal-skeleton');
    expect(skeleton.className).toContain('fixed');
    expect(skeleton.className).toContain('inset-0');
  });

  it('renders modal container with constrained size', () => {
    render(<TaskModalSkeleton />);
    const skeleton = screen.getByTestId('task-modal-skeleton');
    const container = skeleton.querySelector('.max-w-7xl');
    expect(container).toBeInTheDocument();
  });

  it('renders animated pulse placeholders', () => {
    render(<TaskModalSkeleton />);
    const pulses = document.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBeGreaterThan(10);
  });

  it('matches TaskModal layout with two-column body', () => {
    render(<TaskModalSkeleton />);
    const mainContent = document.querySelector('.min-w-\\[28rem\\]');
    const sidebar = document.querySelector('.w-1\\/3.min-w-80');
    expect(mainContent).toBeInTheDocument();
    expect(sidebar).toBeInTheDocument();
  });

  it('renders comments sidebar with multiple comment placeholders', () => {
    render(<TaskModalSkeleton />);
    const sidebar = document.querySelector('.w-1\\/3.min-w-80');
    expect(sidebar).toBeInTheDocument();
    const commentBlocks = sidebar?.querySelectorAll('.rounded-lg.bg-zinc-50, .rounded-lg.dark\\:bg-zinc-700\\/50');
    expect(commentBlocks && commentBlocks.length).toBeGreaterThanOrEqual(3);
  });

  it('renders header, body and footer regions', () => {
    render(<TaskModalSkeleton />);
    const borders = document.querySelectorAll('.border-b, .border-t');
    expect(borders.length).toBeGreaterThanOrEqual(3);
  });
});