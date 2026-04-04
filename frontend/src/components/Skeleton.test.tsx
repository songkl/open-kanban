import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoardSkeleton, Spinner, LoadingOverlay } from './Skeleton';

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