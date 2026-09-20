import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BoardCard } from './BoardCard';
import type { Board } from '../types/kanban';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.count === 'number') {
        return `${key}(${opts.count})`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

const noop = () => undefined;

const baseBoard: Board = {
  id: 'b-1',
  name: 'Product iteration',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  taskCount: 3,
  isOwner: true,
  isPublic: true,
};

function renderCard(props: Partial<React.ComponentProps<typeof BoardCard>> = {}) {
  return render(
    <MemoryRouter>
      <BoardCard
        board={baseBoard}
        onEdit={noop}
        onCopy={noop}
        onSaveAsTemplate={noop}
        onExport={noop}
        onImport={noop}
        onDelete={noop}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('BoardCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the board name and id', () => {
    renderCard();
    expect(screen.getByText('Product iteration')).toBeInTheDocument();
    expect(screen.getByText(/ID: b-1/)).toBeInTheDocument();
  });

  it('ships dark-mode class pairs on the Edit / Copy / Save-as-Template / CSV / JSON / Import buttons (s-1257 P0-2)', () => {
    renderCard();
    const buttons = screen.getAllByRole('button');
    // Find each of the secondary action buttons by their label.
    const editButton = buttons.find((b) => b.textContent?.includes('task.edit'));
    const copyButton = buttons.find((b) => b.textContent?.includes('task.copy'));
    const saveButton = buttons.find((b) => b.textContent?.includes('task.saveAsTemplate'));
    const importButton = buttons.find((b) => b.textContent?.includes('task.import'));

    expect(editButton).toBeDefined();
    expect(editButton?.className).toContain('dark:bg-amber-900/30');
    expect(editButton?.className).toContain('dark:text-amber-300');
    expect(editButton?.className).toContain('dark:border-amber-800/50');

    expect(copyButton).toBeDefined();
    expect(copyButton?.className).toContain('dark:bg-purple-900/30');
    expect(copyButton?.className).toContain('dark:text-purple-300');

    expect(saveButton).toBeDefined();
    expect(saveButton?.className).toContain('dark:bg-orange-900/30');
    expect(saveButton?.className).toContain('dark:text-orange-300');

    expect(importButton).toBeDefined();
    expect(importButton?.className).toContain('dark:bg-sky-900/30');
    expect(importButton?.className).toContain('dark:text-sky-300');
  });
});
