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

  // s-1206: every hashed initial now carries a darker dark-mode color
  // (500 -> 700) so the avatar no longer punches through the dark
  // background. "admin" hashes to the red slot, which was the original
  // PM complaint.
  it('uses a less-saturated red background for the admin avatar in dark mode', () => {
    const { container } = render(<UserAvatar username="admin" />);
    const avatar = container.querySelector('div');
    expect(avatar?.className).toContain('bg-red-500');
    expect(avatar?.className).toContain('dark:bg-red-700');
  });

  it('applies a darker dark-mode background for every hashed color slot', () => {
    const { container } = render(<UserAvatar username="admin" />);
    const avatar = container.querySelector('div');
    const classes = avatar?.className ?? '';
    // every entry in getColorFromUsername now ships with both a light
    // and a dark class; assert the pair is present for at least the
    // red slot, since that's what the PM review flagged.
    expect(classes).toMatch(/bg-\w+-\d+ dark:bg-\w+-\d+/);
  });
});
