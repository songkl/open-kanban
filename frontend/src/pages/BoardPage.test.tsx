import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { BoardPage } from './BoardPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/services/api', () => ({
  boardsApi: {
    getAll: vi.fn().mockResolvedValue([]),
    export: vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob()) }),
  },
  columnsApi: {
    getByBoard: vi.fn().mockResolvedValue([]),
  },
  tasksApi: {
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    archive: vi.fn().mockResolvedValue({}),
    getById: vi.fn().mockResolvedValue({}),
    getByColumn: vi.fn().mockResolvedValue({ data: [], pageCount: 1 }),
  },
  commentsApi: {
    create: vi.fn().mockResolvedValue({}),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ user: null }),
  },
  setGlobalErrorHandler: vi.fn(),
}));

vi.mock('@/hooks/useBoardWebSocket', () => ({
  useBoardWebSocket: () => ({
    wsStatus: 'disconnected' as const,
    reconnectCount: 0,
    connectWebSocket: vi.fn(),
  }),
}));

describe('BoardPage', () => {
  it('renders loading skeleton initially', () => {
    render(
      <BrowserRouter>
        <BoardPage />
      </BrowserRouter>
    );
    expect(document.body.querySelector('[class*="animate-pulse"]')).toBeInTheDocument();
  });

  it('renders without crashing', () => {
    render(
      <BrowserRouter>
        <BoardPage />
      </BrowserRouter>
    );
    expect(document.body).toBeInTheDocument();
  });
});
