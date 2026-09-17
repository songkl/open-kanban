export interface Comment {
  id: string;
  content: string;
  author: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  taskId?: string;
  commentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Subtask {
  id: string;
  title: string;
  completed: boolean;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Custom field definition (s-1197). Stored per board on the client in
 * localStorage under `customFields:<boardId>` because the backend's
 * `tasks.meta` JSON already accepts arbitrary K-V — the definitions are
 * UI metadata (type, color, options) rather than data, so they live with
 * the column settings rather than as another migration. Type controls the
 * editor surface in the modal; `color` is the chip background on the
 * card; `options` is required for single-/multi-select.
 */
export type CustomFieldType = 'text' | 'number' | 'date' | 'single-select' | 'multi-select';

export interface CustomField {
  id: string;
  name: string;
  type: CustomFieldType;
  color: string;
  options?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  position: number;
  priority: string;
  assignee: string | null;
  meta: Record<string, unknown> | null;
  columnId: string;
  archived: boolean;
  archivedAt: string | null;
  published: boolean;
  agentId: string | null;
  agentPrompt: string | null;
  createdBy: string;
  createdByUsername?: string;
  createdByNickname?: string;
  createdByAvatar?: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  subtasks: Subtask[];
  _count?: {
    comments?: number;
    subtasks?: number;
  };
}

export interface Column {
  id: string;
  name: string;
  status: string | null;
  position: number;
  color: string;
  boardId?: string;
  description?: string;
  ownerAgentId?: string;
  tasks: Task[];
  createdAt: string;
  updatedAt: string;
}

/**
 * ColumnAgentBinding is the per-column Agent trigger configuration
 * returned by GET /api/v1/columns (s-1214). When a column carries an
 * `agentConfig`, the bound agent types fire automatically whenever a
 * task crosses the column edge that matches `transitionTrigger` —
 * 'on_enter' on entry, 'on_exit' on exit, 'both' on either edge, and
 * 'none' (the legacy default) for purely-declarative bindings.
 */
export interface ColumnAgentBinding {
  agentTypes: string[];
  transitionTrigger: 'none' | 'on_enter' | 'on_exit' | 'both';
}

export type PermissionAccess = 'READ' | 'WRITE' | 'ADMIN';
export type UserType = 'HUMAN' | 'AGENT';

export interface BoardPermission {
  id: string;
  userId: string;
  userNickname: string;
  username?: string;
  userType: UserType;
  userRole?: 'ADMIN' | 'MEMBER' | 'VIEWER';
  boardId: string;
  boardName: string;
  access: PermissionAccess;
  ownerAgentId?: string | null;
  grantedByUserId?: string | null;
  grantedByUsername?: string | null;
  grantedByNickname?: string | null;
  grantedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface ColumnPermission {
  id: string;
  userId: string;
  userNickname: string;
  username?: string;
  userType: UserType;
  userRole?: 'ADMIN' | 'MEMBER' | 'VIEWER';
  columnId: string;
  columnName: string;
  access: PermissionAccess;
  grantedByUserId?: string | null;
  grantedByUsername?: string | null;
  grantedByNickname?: string | null;
  grantedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface BoardBulkGrantResult {
  success: boolean;
  boardId: string;
  granted: Array<{ userId: string; access: string }>;
  count: number;
}

export interface Board {
  id: string;
  name: string;
  description?: string;
  isPublic?: boolean;
  ownerAgentId?: string | null;
  effectiveAccess?: string;
  isOwner?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  nickname: string;
  avatar: string | null;
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
  type: 'HUMAN' | 'AGENT';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}

export interface Agent extends User {
  tokenCount: number;
}

export interface Token {
  id: string;
  name: string;
  key: string;
  userId: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthClient {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scopes: string[];
  isFirstParty: boolean;
  createdAt: string;
}

export interface OAuthConsent {
  clientId: string;
  clientName: string;
  scope: string;
  grantedAt: string;
}

export interface OAuthConfigEntry {
  key: string;
  value: string;
  default: string;
  description: string;
}

/**
 * Live CLI runner row returned by GET /api/v1/runs/:taskId. Mirrors the
 * `task_runs` table — see backend/internal/handlers/tasks_run.go. The
 * status enum collapses to the four user-facing states the PM review
 * (PM_REVIEW_2026-09-17 §3.6) requires the drawer to render exactly
 * one of: Running, Completed, Failed, Queued.
 *
 *   - `claimed` / `running`   → "Running"
 *   - `completed`             → "Completed"
 *   - `failed`                → "Failed"
 *   - `released`              → "Queued" (runner voluntarily gave the
 *                               task back, awaiting the next claim)
 */
export interface TaskRun {
  id: string;
  taskId: string;
  runnerId: string;
  agentId: string | null;
  status: 'claimed' | 'running' | 'completed' | 'failed' | 'released';
  claimedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

/**
 * Wire-shape returned by GET /api/v1/dashboard/stats (s-1195,
 * PM_REVIEW_2026-09-17 §5.3 ROI #3). All counts default to 0 so
 * callers can render placeholders before the request resolves.
 */
export interface DashboardAgentActivity {
  userId: string;
  nickname: string;
  avatar: string;
  activityCount: number;
}

export interface DashboardBlockedTask {
  taskId: string;
  title: string;
  boardId: string;
  boardName: string;
  columnId: string;
  columnName: string;
  updatedAt: string;
  daysBlocked: number;
  assignee: string;
  priority: string;
}

export interface DashboardStats {
  totalTasks: number;
  tasksByStatus: Record<string, number>;
  tasksByPriority: Record<string, number>;
  publishedTasks: number;
  draftTasks: number;
  archivedTasks: number;
  totalBoards: number;
  activeBoardCount: number;
  totalColumns: number;
  totalUsers: number;
  tasksCompletedLast7Days: number;
  topAgentsByActivity: DashboardAgentActivity[];
  longestBlockedCards: DashboardBlockedTask[];
}
