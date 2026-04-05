import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SafeMarkdown } from './SafeMarkdown';

describe('SafeMarkdown - Security Tests', () => {
  it('renders standard markdown safely', () => {
    render(<SafeMarkdown>**bold** and *italic*</SafeMarkdown>);
    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByText('italic')).toBeInTheDocument();
  });

  it('renders links safely', () => {
    render(<SafeMarkdown>[Link](https://example.com)</SafeMarkdown>);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com');
  });

  it('renders images safely', () => {
    render(<SafeMarkdown>![alt](https://example.com/image.png)</SafeMarkdown>);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://example.com/image.png');
    expect(img).toHaveAttribute('alt', 'alt');
  });

  it('strips script tags from string input', () => {
    const markdown = '<script>alert(1)</script>';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    expect(container.querySelector('script')).toBeNull();
  });

  it('strips javascript: URLs in links', () => {
    const markdown = '[Click](javascript:alert(1))';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    const anchor = container.querySelector('a');
    if (anchor) {
      const href = anchor.getAttribute('href');
      expect(href === null || !href.includes('javascript:')).toBe(true);
    }
  });

  it('strips iframe tags from string input', () => {
    const markdown = '<iframe src="https://evil.com"></iframe>';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('strips object tags from string input', () => {
    const markdown = '<object data="evil.exe"></object>';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    expect(container.querySelector('object')).toBeNull();
  });

  it('strips embed tags from string input', () => {
    const markdown = '<embed src="evil.exe"></embed>';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    expect(container.querySelector('embed')).toBeNull();
  });

  it('strips style tags from string input', () => {
    const markdown = '<style>body { display: none; }</style>';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    expect(container.querySelector('style')).toBeNull();
  });

  it('strips form tags from string input', () => {
    const markdown = '<form action="https://evil.com"><input name="q" /></form>';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    expect(container.querySelector('form')).toBeNull();
  });

  it('strips input tags from string input', () => {
    const markdown = '<input type="text" value="secret" />';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    expect(container.querySelector('input')).toBeNull();
  });

  it('strips button tags from string input', () => {
    const markdown = '<button onclick="alert(1)">Click</button>';
    render(<SafeMarkdown>{markdown}</SafeMarkdown>);
    const container = document.body;
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders code blocks safely', () => {
    render(<SafeMarkdown>{'`const x = 1;`'}</SafeMarkdown>);
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  it('handles empty input gracefully', () => {
    render(<SafeMarkdown>{''}</SafeMarkdown>);
    expect(document.body.textContent).toBe('');
  });

  it('handles null/undefined input gracefully', () => {
    render(<SafeMarkdown>{undefined as any}</SafeMarkdown>);
    expect(document.body.textContent).toBe('');
  });

  it('renders blockquotes safely', () => {
    render(<SafeMarkdown>{'> quote'}</SafeMarkdown>);
    expect(screen.getByText('quote')).toBeInTheDocument();
  });

  it('renders lists safely', () => {
    render(<SafeMarkdown>{'- item1\n- item2'}</SafeMarkdown>);
    expect(screen.getByText('item1')).toBeInTheDocument();
    expect(screen.getByText('item2')).toBeInTheDocument();
  });
});
