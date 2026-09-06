import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserAvatar } from './UserAvatar';

describe('UserAvatar', () => {
  it('renders initial when no avatar URL is provided', () => {
    render(<UserAvatar username="alice" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('returns empty string initial when username is empty', () => {
    const { container } = render(<UserAvatar username="" />);
    expect(container.querySelector('div')?.textContent).toBe('?');
  });

  it('renders image when avatar URL is provided', () => {
    render(<UserAvatar username="alice" avatar="https://example.com/a.png" />);
    const img = screen.getByAltText('alice');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/a.png');
  });

  it('uses username as default title attribute', () => {
    render(<UserAvatar username="alice" />);
    expect(screen.getByTitle('alice')).toBeInTheDocument();
  });

  it('uses custom title prop when provided', () => {
    render(<UserAvatar username="alice" title="Created by alice" />);
    expect(screen.getByTitle('Created by alice')).toBeInTheDocument();
  });

  it('applies title to image avatar as well', () => {
    render(<UserAvatar username="alice" avatar="https://example.com/a.png" title="Custom title" />);
    const img = screen.getByAltText('alice');
    expect(img).toHaveAttribute('title', 'Custom title');
  });

  it('omits title when both title and username are empty', () => {
    const { container } = render(<UserAvatar username="" />);
    const target = container.querySelector('div');
    expect(target?.getAttribute('title')).toBeNull();
  });
});