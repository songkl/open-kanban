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
  userType: UserType;
  columnId: string;
  columnName: string;
  access: PermissionAccess;
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
