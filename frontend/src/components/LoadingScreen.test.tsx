import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingScreen } from './LoadingScreen';

describe('LoadingScreen', () => {
  it('renders loading screen with title', () => {
    render(<LoadingScreen />);
    expect(screen.getByText('Open kanban')).toBeInTheDocument();
  });

  it('renders loading text', () => {
    render(<LoadingScreen />);
    expect(screen.getByText('app.loading')).toBeInTheDocument();
  });

  it('renders spinner icon', () => {
    render(<LoadingScreen />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders with correct structure', () => {
    render(<LoadingScreen />);
    expect(screen.getByText('Open kanban')).toBeInTheDocument();
    expect(screen.getByText('app.loading')).toBeInTheDocument();
  });
});