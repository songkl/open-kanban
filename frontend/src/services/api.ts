import type { Board, Column, Task, Comment, Subtask, Attachment } from '@/types/kanban';

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

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error: ${response.status} - ${error}`);
    }

    return response.json();
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
  create: (data: { id: string; name: string }) =>
    fetchApi<Board>('/api/boards', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name: string }) =>
    fetchApi<Board>(`/api/boards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/boards/${id}`, { method: 'DELETE' }),
};

// Columns API
export const columnsApi = {
  getAll: () => fetchApi<Column[]>('/api/columns'),
  getByBoard: (boardId: string) =>
    fetchApi<Column[]>(`/api/columns?boardId=${boardId}`),
  create: (data: { name: string; boardId: string; color?: string }) =>
    fetchApi<Column>('/api/columns', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; color?: string; position?: number }) =>
    fetchApi<Column>('/api/columns', {
      method: 'PUT',
      body: JSON.stringify({ id, ...data }),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/columns?id=${id}`, { method: 'DELETE' }),
};

// Tasks API
export const tasksApi = {
  getByColumn: (columnId: string) =>
    fetchApi<Task[]>(`/api/tasks?columnId=${columnId}`),
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
  login: (username: string, avatar?: string) =>
    fetchApi<{ user: any; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, avatar }),
    }),
  me: () => fetchApi<any>('/api/auth/me'),
  getAvatars: () => fetchApi<string[]>('/api/auth/login'),
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

// Attachments API
export const attachmentsApi = {
  upload: (file: File, taskId?: string, commentId?: string, onProgress?: (progress: number) => void) => {
    const formData = new FormData();
    formData.append('file', file);
    if (taskId) formData.append('taskId', taskId);
    if (commentId) formData.append('commentId', commentId);

    return new Promise<Attachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/upload`, true);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          const progress = Math.round((event.loaded / event.total) * 100);
          onProgress(progress);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`Upload failed: ${xhr.status} - ${xhr.responseText}`));
        }
      };

      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(formData);
    });
  },

  getByTask: (taskId: string) =>
    fetchApi<Attachment[]>(`/api/tasks/${taskId}/attachments`),

  delete: (id: string) =>
    fetchApi<void>(`/api/attachments/${id}`, { method: 'DELETE' }),
};
