import type { Board, Column, Task, Comment, Subtask, Attachment, Token, User, Agent } from '@/types/kanban';
import i18n from '@/i18n';

export interface Permission {
  id: string;
  boardId: string;
  boardName: string;
  access: string;
}

// Vite environment variables type declaration
declare global {
  interface ImportMetaEnv {
    VITE_API_URL?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

const API_BASE = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.host}`;

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_DELAY = 1000;

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public isNetworkError = false,
    public isAbortError = false
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && error.message.includes('fetch');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

let globalErrorHandler: ((error: Error) => void) | null = null;

export function setGlobalErrorHandler(handler: ((error: Error) => void) | null) {
  globalErrorHandler = handler;
}

async function fetchApi<T>(
  path: string,
  options?: RequestInit & { skip401Handling?: boolean; signal?: AbortSignal }
): Promise<T> {
  const url = `${API_BASE}${path}`;
  try {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      signal: options?.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 401 && !options?.skip401Handling) {
        window.location.href = '/login';
        throw new ApiError(i18n.t('app.error.unauthorized'), 401);
      }
      throw new ApiError(data.error || i18n.t('app.error.requestFailed', { status: response.status }), response.status);
    }

    return data;
  } catch (error) {
    if (isAbortError(error)) {
      const abortError = new ApiError('Request was cancelled', undefined, false, true);
      if (globalErrorHandler) globalErrorHandler(abortError);
      throw abortError;
    }
    if (globalErrorHandler && error instanceof Error) {
      globalErrorHandler(error);
    }
    if (error instanceof ApiError) throw error;
    if (isNetworkError(error)) {
      throw new ApiError(i18n.t('app.error.networkError'), undefined, true);
    }
    throw error;
  }
}

interface RetryOptions {
  retries?: number;
  retryDelay?: number;
  signal?: AbortSignal;
  retryOn?: (error: ApiError) => boolean;
}

async function fetchApiWithRetry<T>(
  path: string,
  options?: RequestInit & { skip401Handling?: boolean; signal?: AbortSignal },
  retryOptions?: RetryOptions
): Promise<T> {
  const retries = retryOptions?.retries ?? DEFAULT_RETRY_COUNT;
  const retryDelay = retryOptions?.retryDelay ?? DEFAULT_RETRY_DELAY;
  const signal = retryOptions?.signal ?? options?.signal;
  const shouldRetry = retryOptions?.retryOn ?? ((err: ApiError) => err.isNetworkError);

  let lastError: ApiError;

  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) {
      throw new ApiError('Request was cancelled', undefined, false, true);
    }

    try {
      return await fetchApi<T>(path, { ...options, signal });
    } catch (error) {
      if (error instanceof ApiError && error.isAbortError) throw error;
      if (!(error instanceof ApiError)) {
        lastError = new ApiError(error instanceof Error ? error.message : String(error), undefined, isNetworkError(error));
      } else {
        lastError = error;
      }

      if (i === retries || !shouldRetry(lastError)) {
        throw lastError;
      }

      const delay = retryDelay * Math.pow(2, i);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new ApiError('Request was cancelled', undefined, false, true));
        });
      });
    }
  }

  throw lastError!;
}

export interface CancellableRequest<T> {
  promise: Promise<T>;
  abort: () => void;
}

export function createApiRequest<T>(
  path: string,
  options?: RequestInit & { skip401Handling?: boolean },
  retryOptions?: RetryOptions
): CancellableRequest<T> {
  const controller = new AbortController();
  const signal = controller.signal;
  const promise = fetchApiWithRetry<T>(path, { ...options, signal }, { ...retryOptions, signal });

  return {
    promise,
    abort: () => controller.abort(),
  };
}

// Boards API
export const boardsApi = {
  getAll: () => fetchApi<Board[]>('/api/v1/boards'),
  create: (data: { id?: string; name: string; description?: string }) =>
    fetchApi<Board>('/api/v1/boards', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createFromTemplate: (data: { name: string; templateId?: string; boardId?: string }) =>
    fetchApi<Board>('/api/v1/boards/from-template', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; description?: string }) =>
    fetchApi<Board>(`/api/v1/boards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/v1/boards/${id}`, { method: 'DELETE' }),
  export: (id: string, format: 'json' | 'csv') => {
    const url = `${API_BASE}/api/v1/boards/${id}/export?format=${format}`;
    return fetch(url, { credentials: 'include' });
  },
  copy: (id: string) =>
    fetchApi<Board>(`/api/v1/boards/${id}/copy`, { method: 'POST' }),
  reset: (id: string) =>
    fetchApi<Board>(`/api/v1/boards/${id}/reset`, { method: 'POST' }),
  import: (data: { data: Record<string, unknown>; boardId?: string; reset?: boolean }) =>
    fetchApi<Board>('/api/v1/boards/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Templates API
interface Template {
  id: string;
  name: string;
  boardId?: string;
  columnsConfig: string;
  includeTasks: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export const templatesApi = {
  getAll: () => fetchApi<Template[]>('/api/v1/templates'),
  create: (data: { name: string; boardId?: string; includeTasks?: boolean }) =>
    fetchApi<Template>('/api/v1/templates', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/v1/templates/${id}`, { method: 'DELETE' }),
};

// Columns API
export const columnsApi = {
  getAll: () => fetchApi<Column[]>('/api/v1/columns'),
  getByBoard: (boardId: string) =>
    fetchApi<Column[]>(`/api/v1/columns?boardId=${boardId}`),
  create: (data: { name: string; boardId: string; color?: string; description?: string; ownerAgentId?: string }) =>
    fetchApi<Column>('/api/v1/columns', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; color?: string; position?: number; status?: string; description?: string; ownerAgentId?: string }) =>
    fetchApi<Column>('/api/v1/columns', {
      method: 'PUT',
      body: JSON.stringify({ id, ...data }),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/v1/columns?id=${id}`, { method: 'DELETE' }),
  reorder: (boardId: string, columns: { id: string; position: number }[]) =>
    fetchApi<void>('/api/v1/columns/reorder', {
      method: 'PUT',
      body: JSON.stringify({ boardId, columns }),
    }),
};

// Tasks API
export const tasksApi = {
  getByColumn: (columnId: string, page = 1, pageSize = 20) =>
    fetchApi<{ data: Task[]; total: number; page: number; pageSize: number; pageCount: number }>(
      `/api/v1/tasks?columnId=${columnId}&page=${page}&pageSize=${pageSize}`
    ),
  getById: (id: string) => fetchApi<Task>(`/api/v1/tasks/${id}`),
  getDrafts: () => fetchApi<Task[]>('/api/v1/drafts'),
  getArchived: () => fetchApi<Task[]>('/api/v1/archived'),
  getCompleted: () => fetchApi<Task[]>('/api/v1/tasks?status=done'),
  create: (data: {
    title: string;
    description?: string;
    columnId: string;
    position?: number;
    priority?: string;
    published?: boolean;
    agentId?: string;
    agentPrompt?: string;
  }) =>
    fetchApi<Task>('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<Task>) =>
    fetchApi<Task>(`/api/v1/tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/v1/tasks/${id}`, { method: 'DELETE' }),
  archive: (id: string, archived: boolean) =>
    fetchApi<Task>(`/api/v1/tasks/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),
};

// Comments API
export const commentsApi = {
  getByTask: (taskId: string) =>
    fetchApi<Comment[]>(`/api/v1/comments?taskId=${taskId}`),
  getById: (id: string) =>
    fetchApi<Comment>(`/api/v1/comments/${id}`),
  create: (data: { taskId: string; content: string; author: string }) =>
    fetchApi<Comment>('/api/v1/comments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Subtasks API
export const subtasksApi = {
  getByTask: (taskId: string) =>
    fetchApi<Subtask[]>(`/api/v1/subtasks?taskId=${taskId}`),
  create: (data: { taskId: string; title: string }) =>
    fetchApi<Subtask>('/api/v1/subtasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { title?: string; completed?: boolean }) =>
    fetchApi<Subtask>(`/api/v1/subtasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/v1/subtasks/${id}`, { method: 'DELETE' }),
};

// Auth API
export const authApi = {
  login: (nickname: string, password?: string, avatar?: string) =>
    fetchApi<{ user: User; token: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ nickname, password, avatar }),
    }),
  init: (username: string, password?: string, avatar?: string, allowRegistration = true, requirePassword = false, authEnabled = true) =>
    fetchApi<{ user: User; token: string }>('/api/v1/auth/init', {
      method: 'POST',
      body: JSON.stringify({ username, password, avatar, allowRegistration, requirePassword, authEnabled }),
    }),
  me: async () => {
    const res = await fetch('/api/v1/auth/me', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok && res.status === 401) {
      return data as { user: null; needsSetup: boolean; allowRegistration?: boolean; requirePassword?: boolean; authEnabled?: boolean };
    }
    if (!res.ok) {
      throw new Error(data.error || `API Error: ${res.status}`);
    }
    return data as {
      user: User;
      needsSetup: boolean;
      allowRegistration?: boolean;
      requirePassword?: boolean;
      authEnabled?: boolean;
      permissions?: Permission[];
    };
  },
  getConfig: () => fetchApi<{ allowRegistration: boolean; requirePassword: boolean; authEnabled: boolean }>('/api/v1/auth/config'),
  updateConfig: (data: { allowRegistration?: boolean; requirePassword?: boolean; authEnabled?: boolean }) =>
    fetchApi<void>('/api/v1/auth/config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  getAvatars: () => fetchApi<{ avatars: string[] }>('/api/v1/auth/avatars'),
  getTokens: () => fetchApi<{ tokens: Token[] }>('/api/v1/auth/token'),
  createToken: (name: string, expiresAt?: string) =>
    fetchApi<{ token: Token }>('/api/v1/auth/token', {
      method: 'POST',
      body: JSON.stringify({ name, expiresAt }),
    }),
  updateToken: (id: string, name: string) =>
    fetchApi<{ token: Token }>(`/api/v1/auth/token?id=${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  deleteToken: (id: string) =>
    fetchApi<void>(`/api/v1/auth/token?id=${id}`, { method: 'DELETE' }),
  getUsers: () => fetchApi<{ users: User[] }>('/api/v1/auth/users').then(res => res.users),
  updateUser: (id: string, data: { nickname?: string; avatar?: string | null; role?: 'ADMIN' | 'MEMBER' | 'VIEWER' }) =>
    fetchApi<User>('/api/v1/auth/users', {
      method: 'PUT',
      body: JSON.stringify({ targetUserId: id, ...data }),
    }),
  getAgents: () => fetchApi<{ agents: Agent[] }>('/api/v1/auth/agents').then(res => res.agents || []),
  createAgent: (nickname: string, avatar?: string, role?: 'ADMIN' | 'MEMBER' | 'VIEWER') =>
    fetchApi<{ agent: Agent & { token: string } }>('/api/v1/auth/agents', {
      method: 'POST',
      body: JSON.stringify({ nickname, avatar, role }),
    }),
  resetAgentToken: (id: string) =>
    fetchApi<{ token: string }>(`/api/v1/auth/agents/reset-token?id=${id}`, {
      method: 'POST',
    }),
  deleteAgent: (id: string) =>
    fetchApi<void>(`/api/v1/auth/agents?id=${id}`, { method: 'DELETE' }),
  getBoards: () => fetchApi<{ boards: Board[] }>('/api/v1/boards').then(res => res.boards),
  getPermissions: (userId: string) =>
    fetchApi<{ permissions: Array<{ id: string; boardId: string; boardName: string; access: string }> }>(`/api/v1/auth/permissions?userId=${userId}`),
  setPermission: (userId: string, boardId: string, access: string) =>
    fetchApi<{ permission: { id: string; userId: string; boardId: string; boardName: string; access: string } }>('/api/v1/auth/permissions', {
      method: 'POST',
      body: JSON.stringify({ userId, boardId, access }),
    }),
  deletePermission: (id: string) =>
    fetchApi<void>(`/api/v1/auth/permissions?id=${id}`, { method: 'DELETE' }),
  getColumnPermissions: (userId?: string, columnId?: string) =>
    fetchApi<{ permissions: Array<{ id: string; columnId: string; columnName: string; access: string; userId: string; userNickname: string }> }>(
      `/api/v1/auth/permissions/columns${userId ? `?userId=${userId}` : columnId ? `?columnId=${columnId}` : ''}`
    ),
  setColumnPermission: (userId: string, columnId: string, access: string) =>
    fetchApi<{ permission: { id: string; userId: string; columnId: string; columnName: string; access: string } }>('/api/v1/auth/permissions/columns', {
      method: 'POST',
      body: JSON.stringify({ userId, columnId, access }),
    }),
  deleteColumnPermission: (id: string) =>
    fetchApi<void>(`/api/v1/auth/permissions/columns?id=${id}`, { method: 'DELETE' }),
  setUserEnabled: (userId: string, enabled: boolean) =>
    fetchApi<void>('/api/v1/auth/users/enabled', {
      method: 'POST',
      body: JSON.stringify({ userId, enabled }),
    }),
};

// Activities API
interface Activity {
  id: string;
  userId: string;
  userNickname?: string;
  userAvatar?: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetTitle?: string;
  details?: string;
  createdAt: string;
}

export const activitiesApi = {
  getAll: (filters?: { action?: string; startTime?: string; endTime?: string; pageSize?: number }) => {
    const params = new URLSearchParams();
    if (filters?.action) params.append('action', filters.action);
    if (filters?.startTime) params.append('startTime', filters.startTime);
    if (filters?.endTime) params.append('endTime', filters.endTime);
    if (filters?.pageSize) params.append('pageSize', String(filters.pageSize));
    const queryString = params.toString();
    return fetchApi<{ activities: Activity[]; hasMore?: boolean; total?: number }>(
      `/api/v1/auth/activities${queryString ? '?' + queryString : ''}`,
      { skip401Handling: true }
    );
  },
  getByAgent: (agentId?: string, offset = 0, limit = 50) => {
    const params = new URLSearchParams();
    params.append('agentOnly', 'true');
    if (agentId) params.append('userId', agentId);
    params.append('limit', String(limit));
    params.append('offset', String(offset));
    return fetchApi<{ activities: Activity[]; hasMore?: boolean; total?: number }>(
      `/api/v1/auth/activities?${params.toString()}`,
      { skip401Handling: true }
    );
  },
  getByUser: (userId: string, offset = 0, limit = 50) => {
    const params = new URLSearchParams();
    params.append('userId', userId);
    params.append('limit', String(limit));
    params.append('offset', String(offset));
    return fetchApi<{ activities: Activity[]; hasMore?: boolean; total?: number }>(
      `/api/v1/auth/activities?${params.toString()}`,
      { skip401Handling: true }
    );
  },
};

// Archived & Drafts API
export const archivedApi = {
  getByBoard: (boardId: string) =>
    fetchApi<Task[]>(`/api/v1/archived?boardId=${boardId}`),
  getAll: () => fetchApi<Task[]>('/api/v1/archived'),
};

export const draftsApi = {
  getByBoard: (boardId: string) =>
    fetchApi<Task[]>(`/api/v1/drafts?boardId=${boardId}`),
  getAll: () => fetchApi<Task[]>('/api/v1/drafts'),
};

interface UploadResult {
  promise: Promise<Attachment>;
  abort: () => void;
}

export const attachmentsApi = {
  upload: (file: File, taskId?: string, commentId?: string, onProgress?: (progress: number) => void): UploadResult => {
    const formData = new FormData();
    formData.append('file', file);
    if (taskId) formData.append('taskId', taskId);
    if (commentId) formData.append('commentId', commentId);

    let xhr: XMLHttpRequest | null = null;
    const abort = () => {
      if (xhr) {
        xhr.abort();
      }
    };

    const promise = new Promise<Attachment>((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/v1/upload`, true);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          const progress = Math.round((event.loaded / event.total) * 100);
          onProgress(progress);
        }
      };

      xhr.onload = () => {
        if (xhr!.status >= 200 && xhr!.status < 300) {
          resolve(JSON.parse(xhr!.responseText));
        } else {
          reject(new Error(`Upload failed: ${xhr!.status} - ${xhr!.responseText}`));
        }
      };

      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.onabort = () => reject(new Error('Upload cancelled'));
      xhr.send(formData);
    });

    return { promise, abort };
  },

  getByTask: (taskId: string) =>
    fetchApi<Attachment[]>(`/api/v1/tasks/${taskId}/attachments`),

  delete: (id: string) =>
    fetchApi<void>(`/api/v1/attachments/${id}`, { method: 'DELETE' }),
};
