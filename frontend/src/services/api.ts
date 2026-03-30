import type { Board, Column, Task, Comment, Subtask, Attachment, Token, User, Agent } from '@/types/kanban';
import i18n from '@/i18n';

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

// Global error handler for API requests
let globalErrorHandler: ((error: Error) => void) | null = null;

export function setGlobalErrorHandler(handler: ((error: Error) => void) | null) {
  globalErrorHandler = handler;
}

async function fetchApi<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE}${path}`;
  try {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        window.location.href = '/login';
        throw new Error(i18n.t('app.error.unauthorized'));
      }
      throw new Error(data.error || i18n.t('app.error.requestFailed', { status: response.status }));
    }

    return data;
  } catch (error) {
    if (globalErrorHandler && error instanceof Error) {
      globalErrorHandler(error);
    }
    throw error;
  }
}

// Boards API
export const boardsApi = {
  getAll: () => fetchApi<Board[]>('/api/boards'),
  create: (data: { id: string; name: string; description?: string }) =>
    fetchApi<Board>('/api/boards', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createFromTemplate: (data: { name: string; templateId?: string; boardId?: string }) =>
    fetchApi<Board>('/api/boards/from-template', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; description?: string }) =>
    fetchApi<Board>(`/api/boards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/boards/${id}`, { method: 'DELETE' }),
  export: (id: string, format: 'json' | 'csv') => {
    const url = `${API_BASE}/api/boards/${id}/export?format=${format}`;
    return fetch(url, { credentials: 'include' });
  },
  copy: (id: string) =>
    fetchApi<Board>(`/api/boards/${id}/copy`, { method: 'POST' }),
  import: (data: { data: any; boardId?: string }) =>
    fetchApi<Board>('/api/boards/import', {
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
  getAll: () => fetchApi<Template[]>('/api/templates'),
  create: (data: { name: string; boardId?: string; includeTasks?: boolean }) =>
    fetchApi<Template>('/api/templates', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/templates/${id}`, { method: 'DELETE' }),
};

// Columns API
export const columnsApi = {
  getAll: () => fetchApi<Column[]>('/api/columns'),
  getByBoard: (boardId: string) =>
    fetchApi<Column[]>(`/api/columns?boardId=${boardId}`),
  create: (data: { name: string; boardId: string; color?: string; description?: string; ownerAgentId?: string }) =>
    fetchApi<Column>('/api/columns', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; color?: string; position?: number; status?: string; description?: string; ownerAgentId?: string }) =>
    fetchApi<Column>('/api/columns', {
      method: 'PUT',
      body: JSON.stringify({ id, ...data }),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/columns?id=${id}`, { method: 'DELETE' }),
};

// Tasks API
export const tasksApi = {
  getByColumn: (columnId: string, page = 1, pageSize = 20) =>
    fetchApi<{ data: Task[]; total: number; page: number; pageSize: number; pageCount: number }>(
      `/api/tasks?columnId=${columnId}&page=${page}&pageSize=${pageSize}`
    ),
  getById: (id: string) => fetchApi<Task>(`/api/tasks/${id}`),
  getDrafts: () => fetchApi<Task[]>('/api/drafts'),
  getArchived: () => fetchApi<Task[]>('/api/archived'),
  getCompleted: () => fetchApi<Task[]>('/api/tasks?status=done'),
  create: (data: {
    title: string;
    description?: string;
    columnId: string;
    position?: number;
    priority?: string;
    published?: boolean;
  }) =>
    fetchApi<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<Task>) =>
    fetchApi<Task>(`/api/tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/tasks/${id}`, { method: 'DELETE' }),
  archive: (id: string, archived: boolean) =>
    fetchApi<Task>(`/api/tasks/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),
};

// Comments API
export const commentsApi = {
  getByTask: (taskId: string) =>
    fetchApi<Comment[]>(`/api/comments?taskId=${taskId}`),
  getById: (id: string) =>
    fetchApi<Comment>(`/api/comments/${id}`),
  create: (data: { taskId: string; content: string; author: string }) =>
    fetchApi<Comment>('/api/comments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Subtasks API
export const subtasksApi = {
  getByTask: (taskId: string) =>
    fetchApi<Subtask[]>(`/api/subtasks?taskId=${taskId}`),
  create: (data: { taskId: string; title: string }) =>
    fetchApi<Subtask>('/api/subtasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { title?: string; completed?: boolean }) =>
    fetchApi<Subtask>(`/api/subtasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/subtasks/${id}`, { method: 'DELETE' }),
};

// Auth API
export const authApi = {
  login: (nickname: string, password?: string, avatar?: string) =>
    fetchApi<{ user: any; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ nickname, password, avatar }),
    }),
  init: (nickname: string, password?: string, avatar?: string, allowRegistration = true, requirePassword = false, authEnabled = true) =>
    fetchApi<{ user: any; token: string }>('/api/auth/init', {
      method: 'POST',
      body: JSON.stringify({ nickname, password, avatar, allowRegistration, requirePassword, authEnabled }),
    }),
  me: async () => {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok && res.status === 401) {
      // Not logged in - return data anyway for needsSetup check
      return data as { user: null; needsSetup: boolean; allowRegistration?: boolean; requirePassword?: boolean; authEnabled?: boolean };
    }
    if (!res.ok) {
      throw new Error(data.error || `API Error: ${res.status}`);
    }
    return data as {
      user: any;
      needsSetup: boolean;
      allowRegistration?: boolean;
      requirePassword?: boolean;
      authEnabled?: boolean;
      permissions?: any[];
    };
  },
  getConfig: () => fetchApi<{ allowRegistration: boolean; requirePassword: boolean; authEnabled: boolean }>('/api/auth/config'),
  updateConfig: (data: { allowRegistration?: boolean; requirePassword?: boolean; authEnabled?: boolean }) =>
    fetchApi<void>('/api/auth/config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  getAvatars: () => fetchApi<{ avatars: string[] }>('/api/auth/avatars'),
  getTokens: () => fetchApi<{ tokens: Token[] }>('/api/auth/token'),
  createToken: (name: string, expiresAt?: string) =>
    fetchApi<{ token: Token }>('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ name, expiresAt }),
    }),
  updateToken: (id: string, name: string) =>
    fetchApi<{ token: Token }>(`/api/auth/token?id=${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  deleteToken: (id: string) =>
    fetchApi<void>(`/api/auth/token?id=${id}`, { method: 'DELETE' }),
  getUsers: () => fetchApi<{ users: User[] }>('/api/auth/users').then(res => res.users),
  updateUser: (id: string, data: { nickname?: string; avatar?: string | null; role?: 'ADMIN' | 'MEMBER' | 'VIEWER' }) =>
    fetchApi<User>('/api/auth/users', {
      method: 'PUT',
      body: JSON.stringify({ targetUserId: id, ...data }),
    }),
  getAgents: () => fetchApi<{ agents: Agent[] }>('/api/auth/agents').then(res => res.agents || []),
  createAgent: (nickname: string, avatar?: string, role?: 'ADMIN' | 'MEMBER' | 'VIEWER') =>
    fetchApi<{ agent: Agent & { token: string } }>('/api/auth/agents', {
      method: 'POST',
      body: JSON.stringify({ nickname, avatar, role }),
    }),
  resetAgentToken: (id: string) =>
    fetchApi<{ token: string }>(`/api/auth/agents/reset-token?id=${id}`, {
      method: 'POST',
    }),
  deleteAgent: (id: string) =>
    fetchApi<void>(`/api/auth/agents?id=${id}`, { method: 'DELETE' }),
  getBoards: () => fetchApi<{ boards: Board[] }>('/api/boards').then(res => res.boards),
  getPermissions: (userId: string) =>
    fetchApi<{ permissions: Array<{ id: string; boardId: string; boardName: string; access: string }> }>(`/api/auth/permissions?userId=${userId}`),
  setPermission: (userId: string, boardId: string, access: string) =>
    fetchApi<{ permission: { id: string; userId: string; boardId: string; boardName: string; access: string } }>('/api/auth/permissions', {
      method: 'POST',
      body: JSON.stringify({ userId, boardId, access }),
    }),
  deletePermission: (id: string) =>
    fetchApi<void>(`/api/auth/permissions?id=${id}`, { method: 'DELETE' }),
  setUserEnabled: (userId: string, enabled: boolean) =>
    fetchApi<void>('/api/auth/users/enabled', {
      method: 'POST',
      body: JSON.stringify({ userId, enabled }),
    }),
};

// Archived & Drafts API
export const archivedApi = {
  getByBoard: (boardId: string) =>
    fetchApi<Task[]>(`/api/archived?boardId=${boardId}`),
  getAll: () => fetchApi<Task[]>('/api/archived'),
};

export const draftsApi = {
  getByBoard: (boardId: string) =>
    fetchApi<Task[]>(`/api/drafts?boardId=${boardId}`),
  getAll: () => fetchApi<Task[]>('/api/drafts'),
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
      xhr.open('POST', `${API_BASE}/api/upload`, true);
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
    fetchApi<Attachment[]>(`/api/tasks/${taskId}/attachments`),

  delete: (id: string) =>
    fetchApi<void>(`/api/attachments/${id}`, { method: 'DELETE' }),
};
