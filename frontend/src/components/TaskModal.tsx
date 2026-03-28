import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Task, Attachment, Column } from '@/types/kanban';
import { columnsApi, subtasksApi, attachmentsApi } from '@/services/api';
import { FileUpload } from './FileUpload';
import { AttachmentList } from './AttachmentList';
import { AddSubtaskModal } from './AddSubtaskModal';

const STORAGE_KEY = 'kanban-username';

// Format comment date
function formatCommentDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return '刚刚';
  } else if (minutes < 60) {
    return `${minutes}分钟前`;
  } else if (hours < 24) {
    return `${hours}小时前`;
  } else if (days < 7) {
    return `${days}天前`;
  } else {
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}

interface Board {
  id: string;
  name: string;
}

interface TaskModalProps {
  task: Task;
  columnName?: string;
  columns?: { id: string; name: string }[];
  boards?: Board[];
  canEdit?: boolean;
  onClose: () => void;
  onUpdate: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onArchive: (taskId: string) => void;
  onAddComment: (taskId: string, content: string, author: string) => void;
}

export function TaskModal({
  task,
  columnName,
  columns = [],
  boards: _boards = [],
  canEdit = true,
  onClose,
  onUpdate,
  onDelete,
  onArchive,
  onAddComment,
}: TaskModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(task.description || '');
  const [editPriority, setEditPriority] = useState(task.priority);
  const [editAssignee, setEditAssignee] = useState(task.assignee || '');
  const [editMeta, setEditMeta] = useState<Record<string, string>>({});
  const [newMetaKey, setNewMetaKey] = useState('');
  const [newMetaValue, setNewMetaValue] = useState('');
  const [newComment, setNewComment] = useState('');
  const [commentAuthor, setCommentAuthor] = useState('');
  const [subtasks, setSubtasks] = useState<any[]>(task.subtasks ?? []);
  const [showAddSubtaskModal, setShowAddSubtaskModal] = useState(false);
  const [editColumn, setEditColumn] = useState(task.columnId);
  const [allColumns, setAllColumns] = useState<Column[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const [pendingCommentAttachments, setPendingCommentAttachments] = useState<Attachment[]>([]);
  const commentsRef = useRef<HTMLDivElement>(null);

  // Parse meta from task
  const parseMeta = (metaStr: string | Record<string, unknown> | null): Record<string, string> => {
    if (!metaStr) return {};
    if (typeof metaStr === 'object' && metaStr !== null) return metaStr as Record<string, string>;
    if (typeof metaStr === 'string') {
      try {
        return JSON.parse(metaStr);
      } catch {
        return {};
      }
    }
    return {};
  };

  // Initialize
  useEffect(() => {
    setIsEditing(false);
    setEditMeta(parseMeta(task.meta));
    const savedUsername = localStorage.getItem(STORAGE_KEY);
    if (savedUsername) {
      setCommentAuthor(savedUsername);
    }
    // Load all columns
    if (task.columnId) {
      const boardId = task.columnId.split('_')[0] || task.columnId;
      columnsApi.getByBoard(boardId).then(setAllColumns).catch(() => setAllColumns([]));
    }
    // Load attachments
    loadAttachments();
    // Scroll to comments if there are comments
    if (task.comments && task.comments.length > 0 && commentsRef.current) {
      setTimeout(() => {
        commentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
    // Handle ESC key to close modal
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [task, onClose]);

  // Load attachments
  const loadAttachments = async () => {
    if (!task?.id) return;
    setLoadingAttachments(true);
    try {
      const data = await attachmentsApi.getByTask(task.id);
      setAttachments(data || []);
    } catch (err) {
      console.error('Failed to load attachments:', err);
      setAttachments([]);
    } finally {
      setLoadingAttachments(false);
    }
  };

  // Handle upload attachment
  const handleUploadAttachment = async (newAttachments: Attachment[]) => {
    setAttachments((prev) => [...prev, ...newAttachments]);
  };

  // Handle delete attachment
  const handleDeleteAttachment = async (id: string) => {
    try {
      await attachmentsApi.delete(id);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error('Failed to delete attachment:', err);
      alert('删除附件失败');
    }
  };

  // Handle upload comment attachment
  const handleUploadCommentAttachment = async (newAttachments: Attachment[]) => {
    setPendingCommentAttachments((prev) => [...prev, ...newAttachments]);
  };

  // Handle remove pending comment attachment
  const handleRemovePendingCommentAttachment = async (id: string) => {
    try {
      await attachmentsApi.delete(id);
      setPendingCommentAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error('Failed to delete attachment:', err);
      alert('删除附件失败');
    }
  };

  const handleAuthorChange = (value: string) => {
    setCommentAuthor(value);
    if (value) {
      localStorage.setItem(STORAGE_KEY, value);
    }
  };

  const handleSave = () => {
    const targetColumnId = editColumn || allColumns[0]?.id || columns[0]?.id;
    if (!targetColumnId) {
      alert('无法保存：没有可用的列');
      return;
    }

    onUpdate({
      ...task,
      title: editTitle,
      description: editDesc || null,
      priority: editPriority,
      assignee: editAssignee || null,
      meta: editMeta,
      columnId: targetColumnId,
    });
    setIsEditing(false);
  };

  const handleAddComment = () => {
    if (newComment.trim()) {
      const author = commentAuthor || localStorage.getItem(STORAGE_KEY) || '匿名用户';
      onAddComment(task.id, newComment.trim(), author);
      setNewComment('');
      // Clear pending comment attachments after submitting
      setPendingCommentAttachments([]);
    }
  };

  const handleAddSubtask = async (title: string) => {
    try {
      const subtask = await subtasksApi.create({ title, taskId: task.id });
      setSubtasks([...subtasks, subtask]);
    } catch (err) {
      console.error('Failed to add subtask:', err);
    }
  };

  const handleToggleSubtask = async (subtaskId: string, completed: boolean) => {
    try {
      await subtasksApi.update(subtaskId, { completed });
      setSubtasks(subtasks.map((s) => (s.id === subtaskId ? { ...s, completed } : s)));
    } catch (err) {
      console.error('Failed to toggle subtask:', err);
    }
  };

  const handleDeleteSubtask = async (subtaskId: string) => {
    try {
      await subtasksApi.delete(subtaskId);
      setSubtasks(subtasks.filter((s) => s.id !== subtaskId));
    } catch (err) {
      console.error('Failed to delete subtask:', err);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => isEditing && setIsEditing(false)}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-shrink-0 border-b border-zinc-100 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-800">
              {isEditing ? '编辑任务' : '任务详情'}
            </h2>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 max-h-[calc(90vh-140px)]">
          {isEditing ? (
            <div className="space-y-6">
              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  标题 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 px-4 py-2.5"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  描述 (支持 Markdown)
                </label>
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  rows={6}
                  className="w-full rounded-lg border border-zinc-200 px-4 py-2.5"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600">状态</label>
                  <select
                    value={editColumn}
                    onChange={(e) => setEditColumn(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2"
                  >
                    {(allColumns.length > 0 ? allColumns : columns).map((col) => (
                      <option key={col.id} value={col.id}>{col.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600">优先级</label>
                  <select
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2"
                  >
                    <option value="low">低优先级</option>
                    <option value="medium">中优先级</option>
                    <option value="high">高优先级</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600">负责人</label>
                  <input
                    type="text"
                    value={editAssignee}
                    onChange={(e) => setEditAssignee(e.target.value)}
                    placeholder="未分配"
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2"
                  />
                </div>
              </div>

              {/* Meta */}
              <div>
                <h4 className="mb-2 text-sm font-semibold text-zinc-600">元信息</h4>
                <div className="space-y-2">
                  {Object.entries(editMeta).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="min-w-[80px] text-sm">{key}:</span>
                      <span className="flex-1 text-sm">{value}</span>
                      <button
                        onClick={() => {
                          const newMeta = { ...editMeta };
                          delete newMeta[key];
                          setEditMeta(newMeta);
                        }}
                        className="text-xs text-red-500"
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newMetaKey}
                      onChange={(e) => setNewMetaKey(e.target.value)}
                      placeholder="键名"
                      className="w-24 rounded border border-zinc-200 px-2 py-1 text-sm"
                    />
                    <input
                      type="text"
                      value={newMetaValue}
                      onChange={(e) => setNewMetaValue(e.target.value)}
                      placeholder="值"
                      className="flex-1 rounded border border-zinc-200 px-2 py-1 text-sm"
                    />
                    <button
                      onClick={() => {
                        if (newMetaKey.trim() && newMetaValue.trim()) {
                          setEditMeta({ ...editMeta, [newMetaKey.trim()]: newMetaValue.trim() });
                          setNewMetaKey('');
                          setNewMetaValue('');
                        }
                      }}
                      className="rounded bg-blue-500 px-3 py-1 text-sm text-white"
                    >
                      添加
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="text-xl font-semibold text-zinc-800">{task.title || 'Untitled'}</h3>
                <div className="mt-1 text-xs text-zinc-400">ID: {task.id || 'Unknown'}</div>
                <div className="mt-2 flex gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                    task.priority === 'high' ? 'bg-red-100 text-red-700' :
                    task.priority === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-green-100 text-green-700'
                  }`}>
                    {task.priority === 'high' ? '高' : task.priority === 'medium' ? '中' : '低'}
                  </span>
                  {task.assignee && (
                    <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                      👤 {task.assignee}
                    </span>
                  )}
                  {columnName && (
                    <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-600">
                      {columnName}
                    </span>
                  )}
                </div>
              </div>

              {task.description && (
                <div>
                  <h4 className="mb-1 text-sm font-medium text-zinc-500">描述</h4>
                  <div className="prose prose-sm max-w-none text-zinc-700 bg-zinc-50 rounded p-3">
                    <ReactMarkdown>{task.description}</ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Subtasks */}
              <div className="mt-4">
                <h4 className="mb-2 text-sm font-medium text-zinc-500">
                  子任务 ({subtasks.length})
                </h4>
                <div className="space-y-2">
                  {subtasks.map((subtask) => (
                    <div key={subtask.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={subtask.completed}
                        onChange={(e) => handleToggleSubtask(subtask.id, e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-200"
                      />
                      <span className={`flex-1 text-sm ${subtask.completed ? 'line-through text-zinc-400' : 'text-zinc-700'}`}>
                        {subtask.title}
                      </span>
                      {canEdit && (
                        <button
                          onClick={() => handleDeleteSubtask(subtask.id)}
                          className="text-xs text-red-500 hover:text-red-600"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {canEdit && (
                  <button
                    onClick={() => setShowAddSubtaskModal(true)}
                    className="mt-2 rounded bg-blue-500 px-3 py-1.5 text-sm text-white hover:bg-blue-600"
                  >
                    + 添加子任务
                  </button>
                )}
              </div>

              {/* Attachments */}
              <div className="mt-4">
                <h4 className="mb-2 text-sm font-medium text-zinc-500">
                  附件 ({attachments.length})
                </h4>
                {loadingAttachments ? (
                  <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    加载中...
                  </div>
                ) : (
                  <>
                    <AttachmentList
                      attachments={attachments}
                      onDelete={canEdit ? handleDeleteAttachment : undefined}
                      canDelete={canEdit}
                    />
                    {canEdit && (
                      <div className="mt-3">
                        <FileUpload
                          taskId={task.id}
                          onUpload={handleUploadAttachment}
                          maxFiles={5}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Meta display */}
              {Object.keys(editMeta).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(editMeta).map(([key, value]) => (
                    <span key={key} className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700">
                      {key}: {value}
                    </span>
                  ))}
                </div>
              )}

              {/* Comments */}
              <div ref={commentsRef} className="mt-6 border-t border-zinc-100 pt-4">
                <h4 className="mb-3 text-sm font-medium text-zinc-500">
                  讨论 ({(task.comments ?? []).length})
                </h4>

                <div className="mb-4 space-y-3">
                  {(task.comments ?? []).length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-lg bg-zinc-50 py-8 text-center">
                      <div className="mb-2 text-3xl">💬</div>
                      <p className="text-sm text-zinc-500">暂无评论</p>
                    </div>
                  ) : (
                    [...(task.comments ?? [])].reverse().map((comment) => {
                      const isOwn = comment.author === commentAuthor || comment.author === localStorage.getItem(STORAGE_KEY);
                      // Get attachments for this comment
                      const commentAttachments = attachments.filter(a => a.commentId === comment.id);
                      return (
                        <div
                          key={comment.id}
                          className={`rounded-lg p-3 ${isOwn ? 'bg-blue-50 border border-blue-100' : 'bg-zinc-50'}`}
                        >
                          <div className="mb-1 flex items-center justify-between">
                            <span className={`text-sm font-medium ${isOwn ? 'text-blue-700' : 'text-zinc-700'}`}>
                              {comment.author}
                            </span>
                            <span className="text-xs text-zinc-400">
                              {formatCommentDate(comment.createdAt)}
                            </span>
                          </div>
                          <div className="prose prose-sm max-w-none text-sm text-zinc-600">
                            <ReactMarkdown>{comment.content}</ReactMarkdown>
                          </div>
                          {/* Comment attachments */}
                          {commentAttachments.length > 0 && (
                            <div className="mt-2">
                              <AttachmentList
                                attachments={commentAttachments}
                                onDelete={canEdit ? handleDeleteAttachment : undefined}
                                canDelete={canEdit}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Comment input */}
                <div className="space-y-2">
                  <input
                    type="text"
                    value={commentAuthor}
                    onChange={(e) => handleAuthorChange(e.target.value)}
                    placeholder="你的名字"
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  />
                  {/* Pending comment attachments */}
                  {pendingCommentAttachments.length > 0 && (
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                      <div className="mb-1 text-xs text-zinc-500">待添加的附件：</div>
                      <AttachmentList
                        attachments={pendingCommentAttachments}
                        onDelete={handleRemovePendingCommentAttachment}
                        canDelete={true}
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <textarea
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleAddComment();
                        }
                      }}
                      placeholder="添加评论... (支持 Markdown，Enter 发送)"
                      rows={3}
                      className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm resize-none"
                    />
                    <button
                      onClick={handleAddComment}
                      disabled={!newComment.trim()}
                      className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
                    >
                      发送
                    </button>
                  </div>
                  {/* Comment file upload */}
                  {canEdit && (
                    <div className="mt-2">
                      <FileUpload
                        taskId={task.id}
                        onUpload={handleUploadCommentAttachment}
                        maxFiles={3}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-shrink-0 flex items-center justify-between border-t border-zinc-100 px-6 py-4">
          {isEditing ? (
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
              >
                保存
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="rounded-md bg-zinc-200 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-300"
              >
                取消
              </button>
            </div>
          ) : canEdit ? (
            <div className="flex gap-3">
              <button
                onClick={() => onArchive(task.id)}
                className="text-sm text-orange-500 hover:text-orange-600"
              >
                归档任务
              </button>
              <button
                onClick={() => onDelete(task.id)}
                className="text-sm text-red-500 hover:text-red-600"
              >
                删除任务
              </button>
            </div>
          ) : (
            <span className="text-sm text-zinc-400">已完成任务不可修改</span>
          )}
          {!isEditing && canEdit && (
            <button
              onClick={() => setIsEditing(true)}
              className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
            >
              编辑
            </button>
          )}
        </div>

        <AddSubtaskModal
          isOpen={showAddSubtaskModal}
          onClose={() => setShowAddSubtaskModal(false)}
          onSubmit={handleAddSubtask}
        />
      </div>
    </div>
  );
}
