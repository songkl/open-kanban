import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar, type SidebarItem } from './Sidebar';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && typeof opts.count === 'number') {
          return `${key}(${opts.count})`;
        }
        return key;
      },
      i18n: { language: 'en', changeLanguage: () => undefined },
    }),
  };
});

const items: SidebarItem[] = [
  { to: '/boards', labelKey: 'nav.sidebarBoards', iconPath: 'M0 0' },
  { to: '/runs', labelKey: 'nav.sidebarRuns', iconPath: 'M0 0', badge: 5 },
  { to: '/settings', labelKey: 'nav.sidebarSettings', iconPath: 'M0 0', badge: 0 },
];

describe('Sidebar', () => {
  it('renders one entry per item with the i18n label', () => {
    render(
      <MemoryRouter>
        <Sidebar items={items} />
      </MemoryRouter>
    );
    expect(screen.getByLabelText('nav.sidebarBoards')).toBeInTheDocument();
    expect(screen.getByLabelText('nav.sidebarRuns')).toBeInTheDocument();
    expect(screen.getByLabelText('nav.sidebarSettings')).toBeInTheDocument();
  });

  it('shows the badge only when count > 0', () => {
    render(
      <MemoryRouter>
        <Sidebar items={items} />
      </MemoryRouter>
    );
    expect(screen.getByTestId('sidebar-badge-nav-sidebarRuns')).toHaveTextContent('5');
    expect(screen.queryByTestId('sidebar-badge-nav-sidebarSettings')).toBeNull();
  });

  it('clamps badge text to 99+ for very large counts', () => {
    render(
      <MemoryRouter>
        <Sidebar items={[{ to: '/a', labelKey: 'nav.sidebarRuns', iconPath: 'M0 0', badge: 250 }]} />
      </MemoryRouter>
    );
    expect(screen.getByTestId('sidebar-badge-nav-sidebarRuns')).toHaveTextContent('99+');
  });

  it('exposes an aria-label on the sidebar container', () => {
    render(
      <MemoryRouter>
        <Sidebar items={items} />
      </MemoryRouter>
    );
    expect(screen.getByLabelText('nav.sidebar')).toBeInTheDocument();
  });
});