import type {
  Board,
  Column,
  Task,
  Comment,
  Subtask,
  Attachment,
  Token,
  User,
  Agent,
  OAuthClient,
  OAuthConsent,
  OAuthConfigEntry,
  BoardPermission,
  ColumnPermission,
  BoardBulkGrantResult,
  TaskRun,
  DashboardStats,
} from '@/types/kanban';
import i18n from '@/i18n';

/**
 * @deprecated Use {@link BoardPermission} from `@/types/kanban` instead.
 * Retained as an alias for backward compatibility.
 */
export type Permission = BoardPermission;

/**
 * Shape returned by GET /api/v1/auth/users-visible. The backend uses
 * `userId` instead of `id` and omits avatar / enabled / timestamps
 * because the endpoint is only used as a permission-management
 * candidate list. We map it back to {@link User} via `toUser` so the
 * existing form components keep working.
 */
interface VisibleUser {
  userId: string;
  username?: string;
  nickname: string;
  type: 'HUMAN' | 'AGENT';
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
}

/**
 * A user that can still be invited to a board, as returned in the
 * `candidates` array of GET /api/v1/auth/permissions?boardId=X. The
 * backend emits the same shape as /api/v1/auth/users-visible, i.e.
 * `userId` instead of `id`, so the field set mirrors {@link VisibleUser}.
 * The array is only present when the request is scoped to a board.
 */
export interface PermissionCandidate {
  userId: string;
  username?: string;
  nickname: string;
  type: 'HUMAN' | 'AGENT';
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
}

function toUser(u: VisibleUser): User {
  return {
    id: u.userId,
    nickname: u.nickname,
    avatar: null,
    role: u.role,
    type: u.type,
    enabled: true,
    createdAt: '',
    updatedAt: '',
  };
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

const API_BASE = (() => {
  const envUrl = import.meta.env.VITE_API_URL;
  if (envUrl && envUrl.trim() !== '') return envUrl;
  return '/api/v1/';
})();

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

export interface AdvancedConfig {
  dbType?: 'sqlite' | 'mysql';
  dbPath?: string;
  dbHost?: string;
  dbPort?: string;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
  serverPort?: string;
  allowedOrigins?: string;
  // Engines compiled into the running server binary. The setup wizard
  // hides / disables any dbType not present in this list so users on a
  // MySQL-only build can't pick SQLite (and vice versa).
  supportedDbTypes?: ('sqlite' | 'mysql')[];
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
  getAll: () => fetchApi<Board[]>('boards'),
  create: (data: { id?: string; name: string; description?: string; isPublic?: boolean }) =>
    fetchApi<Board>('boards', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createFromTemplate: (data: { name: string; templateId?: string; boardId?: string }) =>
    fetchApi<Board>('boards/from-template', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; description?: string; isPublic?: boolean }) =>
    fetchApi<Board>(`boards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`boards/${id}`, { method: 'DELETE' }),
  export: (id: string, format: 'json' | 'csv') => {
    const url = `${API_BASE}boards/${id}/export?format=${format}`;
    return fetch(url, { credentials: 'include' });
  },
  copy: (id: string) =>
    fetchApi<Board>(`boards/${id}/copy`, { method: 'POST' }),
  reset: (id: string) =>
    fetchApi<Board>(`boards/${id}/reset`, { method: 'POST' }),
  import: (data: { data: Record<string, unknown>; boardId?: string; reset?: boolean }) =>
    fetchApi<Board>('boards/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Public read-only share link + iframe embed surface
  // (s-1204, PM_REVIEW_2026-09-17 §6). Mint is owner/admin only;
  // the plaintext value is returned exactly once in the response.
  listViewerTokens: (id: string) =>
    fetchApi<{ tokens: ViewerToken[] }>(`boards/${id}/viewer-tokens`),
  mintViewerToken: (id: string, data: { label?: string; expiresAt?: string | null }) =>
    fetchApi<ViewerToken>(`boards/${id}/viewer-tokens`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  revokeViewerToken: (id: string, tokenId: string) =>
    fetchApi<{ id: string; revoked: boolean }>(
      `boards/${id}/viewer-tokens/${tokenId}`,
      { method: 'DELETE' }
    ),
  getViewerEmbedSnippet: (id: string, token: string) =>
    fetchApi<{ src: string; snippet: string; height: number; width: string }>(
      `boards/${id}/viewer-tokens/embed?token=${encodeURIComponent(token)}`
    ),
};

// Public read-only viewer board surface (s-1204). Anonymous: gated
// by URL secret, returns a sanitized snapshot with no mutating
// surface. Used by /public/b/:token.
export const publicBoardApi = {
  get: (token: string) =>
    fetchApi<PublicBoard>(`public/boards/${encodeURIComponent(token)}`, {
      skip401Handling: true,
    }),
};

export interface ViewerToken {
  id: string;
  boardId: string;
  label: string;
  createdBy?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  // Only present on the mint response — never returned by list /
  // lookup paths.
  token?: string;
}

export interface PublicBoard {
  id: string;
  name: string;
  description: string;
  readOnly: true;
  columns: PublicColumn[];
}

export interface PublicColumn {
  id: string;
  name: string;
  status?: string;
  position: number;
  color: string;
  description: string;
  tasks: PublicTask[];
}

export interface PublicTask {
  id: string;
  title: string;
  description: string;
  priority: string;
  assignee: string;
  meta: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  _count: { comments: number; subtasks: number };
}

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
  getAll: () => fetchApi<Template[]>('templates'),
  create: (data: { name: string; boardId?: string; includeTasks?: boolean }) =>
    fetchApi<Template>('templates', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`templates/${id}`, { method: 'DELETE' }),
};

// Preset templates API (s-1196, PM_REVIEW_2026-09-17 §5.4 ROI #4).
// Powers the public template marketplace and the first-login wizard.
// The GET endpoint is intentionally unauthenticated so the marketplace
// can be browsed from the landing page; admins can disable the entire
// marketplace via the marketplaceEnabled app_config toggle (the server
// returns 404 in that case, which this client surfaces by collapsing
// the result to an empty list).
export interface PresetTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  columnsConfig: string;
  sampleTasks: string;
  sampleAgent: string;
  position: number;
}

export interface QuickstartResult {
  boardId: string;
  boardName: string;
  agentId?: string;
  agentToken?: string;
  demoTaskId?: string;
}

export const presetTemplatesApi = {
  // getAll returns the curated marketplace. We swallow 404s (the disable
  // signal) so callers don't have to special-case a locked-down host.
  getAll: async (): Promise<PresetTemplate[]> => {
    try {
      return await fetchApi<PresetTemplate[]>('preset-templates');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return [];
      }
      throw err;
    }
  },
};

export const onboardingApi = {
  // quickstart materialises a board + sample Agent + demo task in one
  // shot. The InstallAgent / TriggerDemoRun fields use pointer types on
  // the server so an unspecified field keeps the wizard's default
  // (true); the caller opts out explicitly by setting them to false.
  quickstart: (data: {
    presetSlug: string;
    boardName?: string;
    installAgent?: boolean;
    triggerDemoRun?: boolean;
  }) =>
    fetchApi<QuickstartResult>('onboarding/quickstart', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Columns API
export const columnsApi = {
  getAll: () => fetchApi<Column[]>('columns'),
  getByBoard: (boardId: string) =>
    fetchApi<Column[]>(`columns?boardId=${boardId}`),
  getSlug: (name: string) =>
    fetchApi<{ slug: string }>(`columns/slug?name=${encodeURIComponent(name)}`),
  create: (data: { name: string; boardId: string; color?: string; description?: string; ownerAgentId?: string; status?: string }) =>
    fetchApi<Column>('columns', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; color?: string; position?: number; status?: string; description?: string; ownerAgentId?: string }) =>
    fetchApi<Column>('columns', {
      method: 'PUT',
      body: JSON.stringify({ id, ...data }),
    }),
  delete: (id: string) =>
    fetchApi<void>(`columns?id=${id}`, { method: 'DELETE' }),
  reorder: (boardId: string, columns: { id: string; position: number }[]) =>
    fetchApi<void>('columns/reorder', {
      method: 'PUT',
      body: JSON.stringify({ boardId, columns }),
    }),
  /**
   * setAgent replaces the Agent binding for a column (s-1214). When
   * `agentTypes` is empty the row is removed so the column drops out
   * of the auto-trigger fan-out entirely. `transitionTrigger` is one
   * of "none" / "on_enter" / "on_exit" / "both" — see the column
   * workflow triggers spec (PM_REVIEW §3.5).
   */
  setAgent: (
    columnId: string,
    data: { agentTypes: string[]; transitionTrigger: 'none' | 'on_enter' | 'on_exit' | 'both' },
  ) =>
    fetchApi<{ agentTypes: string[]; transitionTrigger: string }>(
      `columns/${columnId}/agent`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
  getAgent: (columnId: string) =>
    fetchApi<{ agentTypes: string[]; transitionTrigger: string }>(
      `columns/${columnId}/agent`,
    ),
  deleteAgent: (columnId: string) =>
    fetchApi<void>(`columns/${columnId}/agent`, { method: 'DELETE' }),
};

// Tasks API
export const tasksApi = {
  getByColumn: (columnId: string, page = 1, pageSize = 20) =>
    fetchApi<{ data: Task[]; total: number; page: number; pageSize: number; pageCount: number }>(
      `tasks?columnId=${columnId}&page=${page}&pageSize=${pageSize}`
    ),
  getById: (id: string) => fetchApi<Task>(`tasks/${id}`),
  getDrafts: () => fetchApi<Task[]>('drafts'),
  getArchived: () => fetchApi<Task[]>('archived'),
  getCompleted: () => fetchApi<Task[]>('tasks?status=done'),
  create: (data: {
    title: string;
    description?: string;
    columnId: string;
    position?: number;
    priority?: string;
    published?: boolean;
    agentId?: string;
    agentPrompt?: string;
    // T-1207 / s-1207, PM_REVIEW_2026-09-17 §3.12: the
    // create-task modal lets the operator pick a due date /
    // assignee / attachment set without leaving the modal. The
    // backend round-trips DueAt as RFC3339 and stores it in
    // tasks.due_at; Assignee is the user/agent id; AttachmentIDs
    // are the rows pre-uploaded via /api/v1/upload that the
    // server re-links to the freshly minted task.
    assignee?: string | null;
    dueAt?: string | null;
    attachmentIds?: string[];
  }) =>
    fetchApi<Task>('tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<Task>) =>
    fetchApi<Task>(`tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`tasks/${id}`, { method: 'DELETE' }),
  archive: (id: string, archived: boolean) =>
    fetchApi<Task>(`tasks/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),
  /**
   * bulkColumnAction powers the column-header ⋯ menu introduced in
   * s-1212. A single click sends a POST to
   * /api/v1/tasks/bulk/column-action with the column id and the
   * chosen action — the server resolves every live task in the
   * column, applies the action, and writes one audit row per
   * request. `affectedIds` is optional and only used to keep the
   * client preview in sync; the server re-queries the column so a
   * stale client cannot trick it into skipping rows.
   */
  bulkColumnAction: (
    columnId: string,
    action: 'archive' | 'complete',
    affectedIds?: string[],
  ) =>
    fetchApi<{
      action: string;
      columnId: string;
      affected: string[];
      count: number;
      skipped: number;
    }>('tasks/bulk/column-action', {
      method: 'POST',
      body: JSON.stringify({ columnId, action, affectedIds }),
    }),
  reorder: (tasks: { id: string; columnId: string; position: number }[]) =>
    fetchApi<{ success: boolean; count: number; details?: string }>('tasks/reorder', {
      method: 'PUT',
      body: JSON.stringify({ tasks }),
    }),
};

// Comments API
export const commentsApi = {
  getByTask: (taskId: string) =>
    fetchApi<Comment[]>(`comments?taskId=${taskId}`),
  getById: (id: string) =>
    fetchApi<Comment>(`comments/${id}`),
  create: (data: { taskId: string; content: string; author: string }) =>
    fetchApi<Comment>('comments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Subtasks API
export const subtasksApi = {
  getByTask: (taskId: string) =>
    fetchApi<Subtask[]>(`subtasks?taskId=${taskId}`),
  create: (data: { taskId: string; title: string }) =>
    fetchApi<Subtask>('subtasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { title?: string; completed?: boolean }) =>
    fetchApi<Subtask>(`subtasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`subtasks/${id}`, { method: 'DELETE' }),
};

// Auth API
export const authApi = {
  login: (nickname: string, password?: string, avatar?: string) =>
    fetchApi<{ user: User; token: string }>('auth/login', {
      method: 'POST',
      body: JSON.stringify({ nickname, password, avatar }),
    }),
  init: (
    username: string,
    password?: string,
    avatar?: string,
    allowRegistration = true,
    requirePassword = false,
    authEnabled = true,
    advanced?: AdvancedConfig,
  ) =>
    fetchApi<{
      user: User;
      token: string;
      requirePassword: boolean;
      configPath?: string;
      restartRequired?: boolean;
    }>('auth/init', {
      method: 'POST',
      body: JSON.stringify({
        username,
        password,
        avatar,
        allowRegistration,
        requirePassword,
        authEnabled,
        advanced,
      }),
    }),
  me: async () => {
    const res = await fetch(`${API_BASE}auth/me`, { credentials: 'include' });
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
  getConfig: () => fetchApi<{ allowRegistration: boolean; requirePassword: boolean; authEnabled: boolean }>('auth/config'),
  getInitDefaults: () =>
    fetchApi<AdvancedConfig>('auth/init-defaults'),
  updateConfig: (data: { allowRegistration?: boolean; requirePassword?: boolean; authEnabled?: boolean }) =>
    fetchApi<void>('auth/config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  getAvatars: () => fetchApi<{ avatars: string[] }>('auth/avatars'),
  getTokens: () => fetchApi<{ tokens: Token[] }>('auth/token'),
  createToken: (name: string, expiresAt?: string) =>
    fetchApi<{ token: Token }>('auth/token', {
      method: 'POST',
      body: JSON.stringify({ name, expiresAt }),
    }),
  updateToken: (id: string, name: string) =>
    fetchApi<{ token: Token }>(`auth/token?id=${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  deleteToken: (id: string) =>
    fetchApi<void>(`auth/token?id=${id}`, { method: 'DELETE' }),
  getUsers: () => fetchApi<{ users: User[] }>('auth/users').then(res => res.users),
  listVisibleUsers: (boardId?: string) => {
    const query = boardId ? `?boardId=${encodeURIComponent(boardId)}` : '';
    return fetchApi<{ users: VisibleUser[] }>(`auth/users-visible${query}`).then((res) =>
      (res.users || []).map(toUser)
    );
  },
  updateUser: (id: string, data: { nickname?: string; avatar?: string | null; role?: 'ADMIN' | 'MEMBER' | 'VIEWER' }) =>
    fetchApi<User>('auth/users', {
      method: 'PUT',
      body: JSON.stringify({ targetUserId: id, ...data }),
    }),
  createUser: (data: { username: string; nickname?: string; password?: string; role?: 'ADMIN' | 'MEMBER' | 'VIEWER'; avatar?: string; boardGrants?: Array<{ boardId: string; access: 'READ' | 'WRITE' | 'ADMIN' }> }) =>
    fetchApi<{ user: User & { token?: string; grantedCount?: number } }>('auth/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getAgents: () => fetchApi<{ agents: Agent[] }>('auth/agents').then(res => res.agents || []),
  createAgent: (nickname: string, avatar?: string, role?: 'ADMIN' | 'MEMBER' | 'VIEWER', boardGrants?: Array<{ boardId: string; access: 'READ' | 'WRITE' | 'ADMIN' }>) =>
    fetchApi<{ agent: Agent & { token: string; grantedCount?: number } }>('auth/agents', {
      method: 'POST',
      body: JSON.stringify({ nickname, avatar, role, boardGrants }),
    }),
  resetAgentToken: (id: string) =>
    fetchApi<{ token: string }>(`auth/agents/reset-token?id=${id}`, {
      method: 'POST',
    }),
  deleteAgent: (id: string) =>
    fetchApi<void>(`auth/agents?id=${id}`, { method: 'DELETE' }),
  getOAuthClients: () => fetchApi<{ clients: OAuthClient[] }>('auth/oauth/clients').then(res => res.clients || []),
  deleteOAuthClient: (clientId: string) =>
    fetchApi<{ deleted: string }>(`auth/oauth/clients?client_id=${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
  getOAuthConsents: () => fetchApi<{ consents: OAuthConsent[] }>('auth/oauth/consents').then(res => res.consents || []),
  revokeOAuthConsent: (clientId: string) =>
    fetchApi<{ revoked: string }>(`auth/oauth/consents?client_id=${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
  getOAuthConfig: () =>
    fetchApi<{ config: OAuthConfigEntry[]; dynamicRegistrationEnabled: boolean }>('auth/oauth/config'),
  updateOAuthConfig: (updates: Record<string, string>) =>
    fetchApi<{ updated: number }>('auth/oauth/config', {
      method: 'PUT',
      body: JSON.stringify({ updates }),
    }),
  getBoards: () => fetchApi<Board[]>('boards'),
  getPermissions: (userId: string) =>
    fetchApi<{ permissions: BoardPermission[] }>(`auth/permissions?userId=${userId}`),
  getBoardPermissions: (boardId: string) =>
    fetchApi<{ permissions: BoardPermission[]; candidates?: PermissionCandidate[] }>(
      `auth/permissions?boardId=${encodeURIComponent(boardId)}`
    ),
  getMyBoardPermissions: (boardId: string) =>
    fetchApi<{
      boardId: string;
      effectiveAccess: string;
      isOwner: boolean;
      canManageBoardPermissions: boolean;
      canManageColumnPermissions: boolean;
    }>(`auth/me/board-permissions?boardId=${encodeURIComponent(boardId)}`),
  getMyColumnAccess: (boardId: string) =>
    fetchApi<{
      boardId: string;
      boardAccess: string;
      isOwner: boolean;
      columns: Record<
        string,
        {
          effectiveAccess: string;
          canCreateTask: boolean;
          canModify: boolean;
          canDelete: boolean;
        }
      >;
    }>(`auth/me/column-access?boardId=${encodeURIComponent(boardId)}`),
  setPermission: (userId: string, boardId: string, access: string) =>
    fetchApi<{ permission: BoardPermission }>('auth/permissions', {
      method: 'POST',
      body: JSON.stringify({ userId, boardId, access }),
    }),
  bulkSetPermissions: (boardId: string, userIds: string[], access: string) =>
    fetchApi<BoardBulkGrantResult>('auth/permissions/bulk', {
      method: 'POST',
      body: JSON.stringify({ boardId, userIds, access }),
    }),
  deletePermission: (id: string) =>
    fetchApi<void>(`auth/permissions?id=${id}`, { method: 'DELETE' }),
  transferOwnership: (boardId: string, newOwnerUserId: string) =>
    fetchApi<{ success: boolean; boardId: string; newOwnerUserId: string }>(
      'auth/permissions/transfer-ownership',
      {
        method: 'POST',
        body: JSON.stringify({ boardId, newOwnerUserId }),
      }
    ),
  getColumnPermissions: (userId?: string, columnId?: string) =>
    fetchApi<{ permissions: ColumnPermission[] }>(
      `auth/permissions/columns${userId ? `?userId=${userId}` : columnId ? `?columnId=${columnId}` : ''}`
    ),
  setColumnPermission: (userId: string, columnId: string, access: string) =>
    fetchApi<{ permission: ColumnPermission }>('auth/permissions/columns', {
      method: 'POST',
      body: JSON.stringify({ userId, columnId, access }),
    }),
  deleteColumnPermission: (id: string) =>
    fetchApi<void>(`auth/permissions/columns?id=${id}`, { method: 'DELETE' }),
  setUserEnabled: (userId: string, enabled: boolean) =>
    fetchApi<void>('auth/users/enabled', {
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
  getAll: (filters?: {
    action?: string;
    startTime?: string;
    endTime?: string;
    pageSize?: number;
    boardId?: string;
    columnId?: string;
    taskId?: string;
  }) => {
    const params = new URLSearchParams();
    if (filters?.action) params.append('action', filters.action);
    if (filters?.startTime) params.append('startTime', filters.startTime);
    if (filters?.endTime) params.append('endTime', filters.endTime);
    if (filters?.pageSize) params.append('pageSize', String(filters.pageSize));
    // s-1208 (PM-s1188 §3.8): scope filters. Each is independently
    // optional and combines with the existing actor/type/time filters
    // — a single GET can ask for, say, `CREATE_TASK` events on a
    // single board in a given time window.
    if (filters?.boardId) params.append('boardId', filters.boardId);
    if (filters?.columnId) params.append('columnId', filters.columnId);
    if (filters?.taskId) params.append('taskId', filters.taskId);
    const queryString = params.toString();
    return fetchApi<{ activities: Activity[]; hasMore?: boolean; total?: number }>(
      `auth/activities${queryString ? '?' + queryString : ''}`,
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
      `auth/activities?${params.toString()}`,
      { skip401Handling: true }
    );
  },
  getByUser: (userId: string, offset = 0, limit = 50) => {
    const params = new URLSearchParams();
    params.append('userId', userId);
    params.append('limit', String(limit));
    params.append('offset', String(offset));
    return fetchApi<{ activities: Activity[]; hasMore?: boolean; total?: number }>(
      `auth/activities?${params.toString()}`,
      { skip401Handling: true }
    );
  },
  /**
   * s-1208: download the same slice the on-screen list would render,
   * as a CSV stream produced server-side. Returns the raw `Response`
   * so the caller can read `Content-Disposition` and stream the blob
   * to a file. Throws ApiError on non-2xx.
   */
  exportCsv: async (filters: {
    action?: string;
    startTime?: string;
    endTime?: string;
    boardId?: string;
    columnId?: string;
    taskId?: string;
  } = {}): Promise<Response> => {
    const params = new URLSearchParams();
    params.append('format', 'csv');
    if (filters.action) params.append('action', filters.action);
    if (filters.startTime) params.append('startTime', filters.startTime);
    if (filters.endTime) params.append('endTime', filters.endTime);
    if (filters.boardId) params.append('boardId', filters.boardId);
    if (filters.columnId) params.append('columnId', filters.columnId);
    if (filters.taskId) params.append('taskId', filters.taskId);
    const url = `${API_BASE}auth/activities/export?${params.toString()}`;
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      let message = i18n.t('app.error.requestFailed', { status: response.status });
      try {
        const data = await response.json();
        if (data?.error) message = data.error;
      } catch {
        // not JSON; fall through with the default
      }
      throw new ApiError(message, response.status);
    }
    return response;
  },
};

// Archived & Drafts API
export const archivedApi = {
  getByBoard: (boardId: string) =>
    fetchApi<Task[]>(`archived?boardId=${boardId}`),
  getAll: () => fetchApi<Task[]>('archived'),
};

// Dashboard API (s-1195, PM_REVIEW_2026-09-17 §5.3 ROI #3).
// Surfaces the four headline tiles the dashboard page renders:
// active board count, tasks completed in the last 7 days, top
// 3 agents by recent activity, and the 3 longest-blocked cards.
export const dashboardApi = {
  getStats: () => fetchApi<DashboardStats>('dashboard/stats'),
};

export const draftsApi = {
  getByBoard: (boardId: string) =>
    fetchApi<Task[]>(`drafts?boardId=${boardId}`),
  getAll: () => fetchApi<Task[]>('drafts'),
};

interface UploadResult {
  promise: Promise<Attachment>;
  abort: () => void;
}

// Notification wire-shape returned by GET /api/v1/notifications.
// The `readAt` field is omitted by the backend when the row hasn't
// been read yet (so the bell list can use `Boolean(n.readAt)` as
// the unread predicate without a separate flag).
export interface Notification {
  id: string;
  userId: string;
  source: 'TASK_ASSIGNED' | 'TASK_MENTIONED' | 'RUN_COMPLETED' | 'WEBHOOK_FAILED';
  title: string;
  body: string;
  targetType: '' | 'TASK' | 'COMMENT' | 'RUN' | 'WEBHOOK';
  targetId: string;
  readAt?: string;
  createdAt: string;
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
      xhr.open('POST', `${API_BASE}/upload`, true);
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
    fetchApi<Attachment[]>(`tasks/${taskId}/attachments`),

  delete: (id: string) =>
    fetchApi<void>(`attachments/${id}`, { method: 'DELETE' }),
};

// Task runs API — surfaces the live `task_runs` row for a task so the
// drawer can decide whether to render the run status badge or fall
// back to the columnName (see PM_REVIEW_2026-09-17 §3.6).
export const runsApi = {
  /**
   * Fetch the latest task_runs row for the given task. Returns
   * `null` when no row exists (either the task was never claimed or
   * the row has been reaped). 404 responses are normalised to null so
   * callers don't need a try/catch around the "no run yet" case.
   */
  getByTask: async (taskId: string, options?: { signal?: AbortSignal }): Promise<TaskRun | null> => {
    const url = `${API_BASE}runs/${encodeURIComponent(taskId)}`;
    try {
      const response = await fetch(url, {
        credentials: 'include',
        signal: options?.signal,
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.status === 404) return null;
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          throw new ApiError(i18n.t('app.error.unauthorized'), 401);
        }
        throw new ApiError(data?.error || i18n.t('app.error.requestFailed', { status: response.status }), response.status);
      }
      // s-1244 (PM review s-1243 P1-2): the server now returns
      // `{ run: null, hasRun: false }` on the empty case instead of
      // a 404, so the browser doesn't log a red error on every
      // board page load. Accept both the new envelope and the legacy
      // bare-run shape.
      if (data === null || data === undefined) return null;
      if (data && typeof data === 'object' && 'hasRun' in data) {
        return (data.run ?? null) as TaskRun | null;
      }
      return data as TaskRun;
    } catch (error) {
      if (isAbortError(error)) {
        throw new ApiError('Request was cancelled', undefined, false, true);
      }
      if (error instanceof ApiError) throw error;
      if (isNetworkError(error)) {
        throw new ApiError(i18n.t('app.error.networkError'), undefined, true);
      }
      throw error;
    }
  },
};

// Notifications API (s-1194). Powers the bell-badge UI in the new
// global top bar; the GET endpoint also returns `unreadCount` so the
// badge can hydrate without a second round-trip.
export interface NotificationListResult {
  notifications: Notification[];
  unreadCount: number;
}

export const notificationsApi = {
  /**
   * Fetch the caller's notifications, newest first.
   *
   * @param opts.unreadOnly when true, only unread rows are returned.
   *                        The bell list uses this on first paint to
   *                        avoid paging through already-read rows.
   * @param opts.limit      defaults to 50, capped at 100 server-side.
   * @param opts.offset     defaults to 0; bell-list virtual scroll
   *                        passes an incrementing offset to load more.
   */
  list: (opts?: { unreadOnly?: boolean; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (opts?.unreadOnly) params.set('unreadOnly', 'true');
    if (typeof opts?.limit === 'number') params.set('limit', String(opts.limit));
    if (typeof opts?.offset === 'number') params.set('offset', String(opts.offset));
    const qs = params.toString();
    return fetchApi<NotificationListResult>(`notifications${qs ? `?${qs}` : ''}`);
  },
  /**
   * Mark a single notification read. Idempotent — a second call on
   * an already-read row returns 200 with the original readAt, not 404.
   */
  markRead: (id: string) =>
    fetchApi<{ success: boolean; readAt: string }>(`notifications/${id}/read`, {
      method: 'POST',
    }),
  /**
   * Mark every unread row owned by the caller read. Single UPDATE,
   * so it's cheap enough to call on bell-list close.
   */
  markAllRead: () =>
    fetchApi<{ success: boolean; readAt: string }>('notifications/read-all', {
      method: 'POST',
    }),
};

// Per-user notification preferences (s-1203, PM_REVIEW_2026-09-17 §3.7).
// Backs the "Notifications" section in Settings — every authenticated
// user can read/write their own row, regardless of role.
export interface NotificationPreferences {
  userId: string;
  emailEnabled: boolean;
  webhookEnabled: boolean;
  webhookUrl: string;
  updatedAt: string;
}

export type NotificationPreferencesPatch = Partial<
  Pick<NotificationPreferences, 'emailEnabled' | 'webhookEnabled' | 'webhookUrl'>
>;

export const notificationPreferencesApi = {
  /**
   * Fetch the caller's notification preferences. The backend returns
   * the documented defaults (email + webhook on, empty URL) when the
   * user has never saved a row, so callers can treat the result as
   * always-defined.
   */
  get: () => fetchApi<NotificationPreferences>('auth/me/notification-preferences'),
  /**
   * Partial update: omitted fields are preserved on the server. The
   * Settings tab uses this to toggle one switch at a time without
   * re-sending the whole row.
   */
  update: (patch: NotificationPreferencesPatch) =>
    fetchApi<NotificationPreferences>('auth/me/notification-preferences', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
};

// Admin-only error reporting configuration (s-1210,
// PM_REVIEW_2026-09-17 §7). Backed by the
// /api/v1/frontend-events/config endpoints added in the same
// task. The Settings → Error Reporting tab uses this to flip
// the global sink on/off for the whole deployment — a
// self-hosted admin can disable remote capture of unhandled
// exceptions without rebuilding the frontend bundle.
export interface FrontendEventsConfig {
  enabled: boolean;
}

export const frontendEventsApi = {
  /** Read the current admin-side toggle. Admin-only on the server. */
  getConfig: () => fetchApi<FrontendEventsConfig>('frontend-events/config'),
  /**
   * Flip the admin-side toggle. When set to false the ingest
   * endpoint returns 204 with no row written, which the
   * client treats as "all good, nothing to do" so the
   * disabled sink does not turn into a flood of console
   * errors on every page.
   */
  setConfig: (enabled: boolean) =>
    fetchApi<FrontendEventsConfig>('frontend-events/config', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  /** Admin-only list of the most recent captured events. */
  list: (limit = 50) =>
    fetchApi<{ events: Array<{
      id: string;
      eventType: string;
      message?: string;
      stack?: string;
      url?: string;
      source?: string;
      details?: Record<string, unknown>;
      receivedAt: string;
      userId?: string;
    }>; total: number }>(`frontend-events?limit=${limit}`),
};

// Public /api/v1/status payload (s-1211). The endpoint is
// intentionally unauthenticated so the /status page can be
// opened by anyone — including unauthenticated visitors who
// want to confirm an instance is up before logging in. We
// pin skip401Handling to true as belt-and-braces: if the
// route ever gets accidentally wrapped in auth middleware
// the /status page would otherwise bounce to /login, which
// is exactly the wrong UX for an "is the server alive?" page.
export interface StatusReport {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  version: string;
  uptimeSeconds: number;
  database: {
    type: string;
    version: string;
    reachable: boolean;
  };
  migration: {
    lastAppliedAt: string;
    lastVersion: string;
  };
  counts: {
    tasks: number;
    activities: number;
    activitiesLast24h: number;
  };
  agents: {
    total: number;
    active: number;
  };
  webhook: {
    enabled: boolean;
    urlConfigured: boolean;
    lastFailureAt?: string;
    recentFailures: number;
  };
}

export const statusApi = {
  /** Fetch the rich /api/v1/status payload. Public — no auth required. */
  get: () => fetchApi<StatusReport>('status', { skip401Handling: true }),
};
