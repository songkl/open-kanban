import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    getAll: vi.fn().mockResolvedValue([
      { id: 'board-1', name: 'Test Board', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    ]),
    export: vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob()) }),
  },
  columnsApi: {
    getByBoard: vi.fn().mockResolvedValue([
      {
        id: 'col-1',
        name: 'To Do',
        status: 'todo',
        position: 0,
        color: '#3b82f6',
        tasks: [],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ]),
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
    me: vi.fn().mockResolvedValue({ user: { id: 'user-1', nickname: 'TestUser', avatar: null, role: 'MEMBER', type: 'HUMAN', enabled: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' } }),
  },
  setGlobalErrorHandler: vi.fn(),
}));

const mockWebSocket = {
  onopen: null,
  onclose: null,
  onmessage: null,
  onerror: null,
  close: vi.fn(),
  send: vi.fn(),
  readyState: 1,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
};
vi.spyOn(global, 'WebSocket').mockImplementation(() => mockWebSocket as any);

const renderBoardPage = () => {
  return render(
    <BrowserRouter>
      <BoardPage />
    </BrowserRouter>
  );
};

describe('BoardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading skeleton initially', () => {
    renderBoardPage();
    expect(document.body.querySelector('[class*="animate-pulse"]')).toBeInTheDocument();
  });
});
