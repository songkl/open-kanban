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
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  subtasks: Subtask[];
  _count?: {
    comments?: number;
    subtasks?: number;
  };
}

/**
 * TaskRun mirrors the server-side `task_runs` row (see
 * `devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §3.3 and
 * `devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml` §TaskRun). The badge
 * endpoint (`GET /api/v1/runs/:taskId`) only ever surfaces the live
 * `claimed` / `running` states — finished rows are normally deleted
 * by the server, so a 404 is the "no active run" signal the UI uses
 * to hide the badge. The history endpoint
 * (`GET /api/v1/runs/history`) instead lists terminal
 * (`completed` / `failed` / `released`) rows that *do* persist,
 * and those rows carry the optional `finishedAt` / `exitCode` /
 * `error` fields below.
 */
export interface TaskRun {
  taskId: string;
  runnerId: string;
  agentId: string;
  boardId: string;
  columnId: string;
  status: 'claimed' | 'running' | 'completed' | 'failed' | 'released';
  claimedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  error?: string | null;
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

export interface Board {
  id: string;
  name: string;
  description?: string;
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

export type PermissionAccess = 'READ' | 'WRITE' | 'ADMIN';

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
