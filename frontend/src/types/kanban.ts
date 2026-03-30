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
  meta: Record<string, any> | null;
  columnId: string;
  archived: boolean;
  archivedAt: string | null;
  published: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  subtasks: Subtask[];
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
