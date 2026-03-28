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
  tasks: Task[];
  createdAt: string;
  updatedAt: string;
}

export interface Board {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  username: string;
  avatar: string | null;
  role: 'ADMIN' | 'USER';
  type: 'HUMAN' | 'AGENT';
  createdAt: string;
  updatedAt: string;
}
