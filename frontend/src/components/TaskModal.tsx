import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { SafeMarkdown } from './SafeMarkdown';
import { UserAvatar } from './UserAvatar';
import type { Task, Attachment, Column, Agent, Subtask, Comment } from '@/types/kanban';

const MarkdownEditor = lazy(() => import('@/components/MarkdownEditor'));
import { columnsApi, subtasksApi, attachmentsApi, authApi, commentsApi } from '@/services/api';
import { AttachmentList } from './AttachmentList';
import { AddSubtaskModal } from './AddSubtaskModal';

const STORAGE_KEY = 'kanban-username';

function formatCommentDate(t: ReturnType<typeof useTranslation>[0], dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return t('taskModal.justNow');
  } else if (minutes < 60) {
    return t('taskModal.minutesAgo', { count: minutes });
  } else if (hours < 24) {
    return t('taskModal.hoursAgo', { count: hours });
  } else if (days < 7) {
    return t('taskModal.daysAgo', { count: days });
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
  boardId?: string;
  boards?: Board[];
  canEdit?: boolean;
  startEditing?: boolean;
  onClose: () => void;
  onUpdate: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onArchive: (taskId: string) => void;
  onAddComment: (taskId: string, content: string, author: string) => void;
  onEditingStarted?: () => void;
}

export function TaskModal({
  task,
  columnName,
  columns = [],
  boardId,
  boards: _boards = [],
  canEdit = true,
  startEditing = false,
  onClose,
  onUpdate,
  onDelete,
  onArchive,
  onAddComment,
  onEditingStarted,
}: TaskModalProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);

  useEffect(() => {
    if (startEditing && !isEditing) {
      setIsEditing(true);
      onEditingStarted?.();
    }
  }, [startEditing, isEditing, onEditingStarted]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'Enter' && isEditing) {
        const target = e.target as HTMLElement;
        const isTextarea = target.tagName === 'TEXTAREA' || target.closest('textarea');
        if (!isTextarea) {
          e.preventDefault();
          handleSaveRef.current();
          return;
        }
      }

      if (e.key === 'Tab' && isEditing) {
        e.preventDefault();
        const fieldOrder = [
          titleInputRef,
          statusSelectRef,
          prioritySelectRef,
          assigneeSelectRef,
          metaKeyInputRef,
        ];
        const currentIndex = fieldOrder.findIndex(ref => ref.current === e.target);
        if (currentIndex === -1) {
          titleInputRef.current?.focus();
        } else {
          const nextIndex = e.shiftKey
            ? (currentIndex - 1 + fieldOrder.length) % fieldOrder.length
            : (currentIndex + 1) % fieldOrder.length;
          fieldOrder[nextIndex]?.current?.focus();
        }
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isEditing]);

  const [editDesc, setEditDesc] = useState(task.description || '');
  const [editPriority, setEditPriority] = useState(task.priority);
  const [editAssignee, setEditAssignee] = useState(task.assignee || '');
  const [editAgentId, setEditAgentId] = useState(task.agentId || '');
  const [editAgentPrompt, setEditAgentPrompt] = useState(task.agentPrompt || '');
  const [editMeta, setEditMeta] = useState<Record<string, string>>({});
  const [newMetaKey, setNewMetaKey] = useState('');
  const [newMetaValue, setNewMetaValue] = useState('');
  const [newComment, setNewComment] = useState('');
  const [commentAuthor, setCommentAuthor] = useState('');
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks ?? []);
  const [showAddSubtaskModal, setShowAddSubtaskModal] = useState(false);
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [editColumn, setEditColumn] = useState(task.columnId);
  const [allColumns, setAllColumns] = useState<Column[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const [uploadingInProgress, setUploadingInProgress] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [currentUser, setCurrentUser] = useState<{ nickname: string } | null>(null);
  const commentsRef = useRef<HTMLDivElement>(null);
  const commentEditorRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const statusSelectRef = useRef<HTMLSelectElement>(null);
  const prioritySelectRef = useRef<HTMLSelectElement>(null);
  const assigneeSelectRef = useRef<HTMLSelectElement>(null);
  const metaKeyInputRef = useRef<HTMLInputElement>(null);
  const handleSaveRef = useRef<() => void>(() => {});
  const handleSaveRefDeps = useRef<unknown[]>([]);
  const [commentsPage, setCommentsPage] = useState(1);
  const [taskComments, setTaskComments] = useState<Comment[]>(task.comments ?? []);
  const COMMENTS_PER_PAGE = 10;
  const [isFullscreen, setIsFullscreen] = useState(false);

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

  useEffect(() => {
    const loadAuthor = async () => {
      try {
        const meData = await authApi.me();
        if (meData.user) {
          setCurrentUser(meData.user);
          setCommentAuthor(meData.user.nickname);
          localStorage.setItem(STORAGE_KEY, meData.user.nickname);
        }
      } catch {
        const savedAuthor = localStorage.getItem(STORAGE_KEY);
        if (savedAuthor) {
          setCommentAuthor(savedAuthor);
        }
      }
    };
    loadAuthor();
  }, []);

  useEffect(() => {
    setEditMeta(parseMeta(task.meta));
  }, [task.meta]);

  useEffect(() => {
    if (boardId) {
      columnsApi.getByBoard(boardId).then((data) => setAllColumns(data || [])).catch(console.error);
    }
  }, [boardId]);

  useEffect(() => {
    if (task.id) {
      setLoadingAttachments(true);
      attachmentsApi.getByTask(task.id)
        .then((data) => setAttachments(data || []))
        .catch(console.error)
        .finally(() => setLoadingAttachments(false));
    }
  }, [task.id]);

  useEffect(() => {
    if (task.id && (!task.comments || task.comments.length === 0)) {
      commentsApi.getByTask(task.id)
        .then((data) => setTaskComments(data || []))
        .catch(console.error);
    } else if (task.comments) {
      setTaskComments(task.comments);
    }
  }, [task.id, task.comments]);

  useEffect(() => {
    if (commentsRef.current) {
      commentsRef.current.scrollTop = commentsRef.current.scrollHeight;
    }
  }, [taskComments]);

  useEffect(() => {
    authApi.getAgents().then(setAgents).catch(console.error);
  }, []);

  const handleAuthorChange = (value: string) => {
    setCommentAuthor(value);
    localStorage.setItem(STORAGE_KEY, value);
  };

  const handleSave = useCallback(async () => {
    try {
      const updatedTask = {
        ...task,
        title: editTitle,
        description: editDesc,
        priority: editPriority,
        assignee: editAssignee,
        meta: editMeta,
        columnId: editColumn,
        agentId: editAgentId || null,
        agentPrompt: editAgentPrompt || null,
      };
      await onUpdate(updatedTask);
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to save task:', error);
    }
  }, [task, editTitle, editDesc, editPriority, editAssignee, editMeta, editColumn, editAgentId, editAgentPrompt, onUpdate]);

  useEffect(() => {
    const deps = [task, editTitle, editDesc, editPriority, editAssignee, editMeta, editColumn, editAgentId, editAgentPrompt, onUpdate];
    if (handleSaveRefDeps.current.join() !== deps.join()) {
      // eslint-disable-next-line react-hooks/immutability
      handleSaveRef.current = handleSave;
      handleSaveRefDeps.current = deps;
    }
  });

  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    onAddComment(task.id, newComment.trim(), commentAuthor);
    setNewComment('');
  };

  const handleSubtasksChange = (newSubtasks: Subtask[]) => {
    setSubtasks(newSubtasks);
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    await attachmentsApi.delete(attachmentId);
    setAttachments(attachments.filter(a => a.id !== attachmentId));
  };

  const uploadImage = useCallback(async (file: File): Promise<string | null> => {
    try {
      const { promise } = attachmentsApi.upload(file, task.id);
      const attachment = await promise;
      setAttachments(prev => [...prev, attachment]);
      return attachment.url;
    } catch (error) {
      console.error('Failed to upload image:', error);
      return null;
    }
  }, [task.id]);

  const insertImageMarkdown = (currentValue: string, imageUrl: string, altText: string = 'image'): string => {
    const imageMarkdown = `\n![${altText}](${imageUrl})\n`;
    return currentValue + imageMarkdown;
  };

  const handleEditorPaste = useCallback(async (e: React.ClipboardEvent, target: 'desc' | 'comment') => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          setUploadingInProgress(true);
          const url = await uploadImage(file);
          setUploadingInProgress(false);
          if (url) {
            if (target === 'desc') {
              setEditDesc(prev => insertImageMarkdown(prev, url, file.name));
            } else {
              setNewComment(prev => insertImageMarkdown(prev, url, file.name));
            }
          }
        }
        return;
      }
    }
  }, [uploadImage]);

  const handleEditorDrop = useCallback(async (e: React.DragEvent, target: 'desc' | 'comment') => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    e.preventDefault();
    e.stopPropagation();

    setUploadingInProgress(true);
    for (const file of imageFiles) {
      const url = await uploadImage(file);
      if (url) {
        if (target === 'desc') {
          setEditDesc(prev => insertImageMarkdown(prev, url, file.name));
        } else {
          setNewComment(prev => insertImageMarkdown(prev, url, file.name));
        }
      }
    }
    setUploadingInProgress(false);
  }, [uploadImage]);

  const handleDelete = () => {
    setShowDeleteConfirmModal(true);
  };

  const confirmDelete = () => {
    setShowDeleteConfirmModal(false);
    onDelete(task.id);
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/70 overflow-y-auto ${isFullscreen ? 'p-0' : ''}`}>
      <div className={`relative z-10 flex flex-col bg-white dark:bg-zinc-800 rounded-xl shadow-xl overflow-hidden ${isFullscreen ? 'w-screen h-screen max-w-full max-h-full rounded-none' : 'h-full max-h-[calc(100vh-4rem)] my-8 mx-auto max-w-7xl'}`}>
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between border-b border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <div className="flex items-center gap-3 flex-wrap">
            {columnName && (
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-700 px-3 py-1 text-sm text-zinc-600 dark:text-zinc-300">
                {columnName}
              </span>
            )}
            {!isEditing && (
              <div>
                <h2 className="text-xl font-bold text-zinc-800 dark:text-zinc-100">{task.title}</h2>
                <div className="mt-1 flex items-center gap-4 text-xs text-zinc-400 dark:text-zinc-500">
                  <span>{t('taskModal.publishedAt')}: {new Date(task.createdAt).toLocaleString()}</span>
                  {task.updatedAt !== task.createdAt && (
                    <span>{t('taskModal.updatedAt')}: {new Date(task.updatedAt).toLocaleString()}</span>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!isEditing && canEdit && (
              <button
                onClick={() => setIsEditing(true)}
                className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
              >
                {t('taskModal.editTask')}
              </button>
            )}
            <button
              onClick={() => {
                navigator.clipboard.writeText(task.id);
              }}
              title={t('taskModal.copyTaskId')}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={t('taskModal.fullscreen')}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              {isFullscreen ? (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              )}
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Main Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* Title - only show input when editing, title is in header otherwise */}
            {isEditing && (
              <input
                ref={titleInputRef}
                id="task-title-input"
                name="task-title-input"
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="mb-4 w-full rounded-lg border border-zinc-200 px-4 py-2.5 text-xl font-semibold"
              />
            )}

            {/* Description */}
            <div className="mb-6">
              <label className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                {t('taskModal.description')} {isEditing && t('taskModal.descriptionHint')}
              </label>
              {isEditing ? (
                <div
                  id="desc-editor"
                  className="rounded-lg border border-zinc-200 overflow-y-auto"
                  onPaste={(e) => handleEditorPaste(e, 'desc')}
                  onDrop={(e) => handleEditorDrop(e, 'desc')}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <Suspense fallback={<textarea className="w-full rounded-lg border border-zinc-200 px-3 py-2 font-mono text-sm resize-none" style={{ height: 200 }} disabled />}>
                    <MarkdownEditor
                      value={editDesc}
                      onChange={(val) => setEditDesc(val || '')}
                      height={200}
                    />
                  </Suspense>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none rounded-lg bg-zinc-50 dark:bg-zinc-700/50 p-4">
                  {task.description ? (
                    <SafeMarkdown>{task.description}</SafeMarkdown>
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-500">{t('taskModal.noDescription')}</span>
                  )}
                </div>
              )}
            </div>

            {/* Grid Layout for Edit Mode */}
            {isEditing && (
              <div className="mb-6 grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600">{t('taskModal.status')}</label>
                  <select
                    ref={statusSelectRef}
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
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600">{t('taskModal.priority')}</label>
                  <select
                    ref={prioritySelectRef}
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2"
                  >
                    <option value="low">{t('taskModal.priorityLow')}</option>
                    <option value="medium">{t('taskModal.priorityMedium')}</option>
                    <option value="high">{t('taskModal.priorityHigh')}</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600">{t('taskModal.assignee')}</label>
                  <select
                    ref={assigneeSelectRef}
                    value={editAssignee}
                    onChange={(e) => setEditAssignee(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2"
                  >
                    <option value="">{t('taskModal.unassigned')}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.nickname}>
                        {agent.nickname}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600">{t('taskModal.agentId')}</label>
                  <input
                    type="text"
                    value={editAgentId}
                    onChange={(e) => setEditAgentId(e.target.value)}
                    placeholder={t('taskModal.agentIdPlaceholder')}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2"
                  />
                </div>

                <div className="col-span-2">
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600">{t('taskModal.agentPrompt')}</label>
                  <textarea
                    value={editAgentPrompt}
                    onChange={(e) => setEditAgentPrompt(e.target.value)}
                    placeholder={t('taskModal.agentPromptPlaceholder')}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 resize-none"
                  />
                </div>
              </div>
            )}

            {/* Meta */}
            <div>
              <h4 className="mb-2 text-sm font-semibold text-zinc-600">{t('taskModal.meta')}</h4>
              <div className="space-y-2">
                {Object.entries(editMeta).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="min-w-[80px] text-sm">{key}:</span>
                    <span className="flex-1 text-sm">{value}</span>
                    {isEditing && (
                      <button
                        onClick={() => {
                          const newMeta = { ...editMeta };
                          delete newMeta[key];
                          setEditMeta(newMeta);
                        }}
                        className="text-xs text-red-500"
                      >
                        {t('taskModal.deleteMeta')}
                      </button>
                    )}
                  </div>
                ))}
                {isEditing && (
                  <div className="flex gap-2">
                    <input
                      ref={metaKeyInputRef}
                      type="text"
                      value={newMetaKey}
                      onChange={(e) => setNewMetaKey(e.target.value)}
                      placeholder={t('taskModal.metaKey')}
                      className="w-24 rounded border border-zinc-200 px-2 py-1 text-sm"
                    />
                    <input
                      type="text"
                      value={newMetaValue}
                      onChange={(e) => setNewMetaValue(e.target.value)}
                      placeholder={t('taskModal.metaValue')}
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
                      className="rounded bg-blue-500 px-3 py-1 text-sm text-white hover:bg-blue-600"
                    >
                      {t('taskModal.add')}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Subtasks */}
            <div className="mt-6">
              <div className="mb-3 flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-zinc-600">
                  {t('taskModal.subtasks')} ({subtasks.filter(s => s.completed).length}/{subtasks.length})
                </h4>
                {isEditing && (
                  <button
                    onClick={() => setShowAddSubtaskModal(true)}
                    className="text-sm text-blue-500 hover:text-blue-600"
                  >
                    + {t('taskModal.addSubtask')}
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {subtasks.map((subtask) => (
                  <div key={subtask.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={subtask.completed}
                      onChange={(e) => {
                        if (isEditing) {
                          subtasksApi.update(subtask.id, { completed: e.target.checked })
                            .then(() => {
                              const newSubtasks = subtasks.map(s =>
                                s.id === subtask.id ? { ...s, completed: e.target.checked } : s
                              );
                              handleSubtasksChange(newSubtasks);
                            });
                        }
                      }}
                      disabled={!isEditing}
                      className="h-4 w-4 rounded border-zinc-300"
                    />
                    <span className={`flex-1 text-sm ${subtask.completed ? 'text-zinc-400 line-through' : 'text-zinc-700'}`}>
                      {subtask.title}
                    </span>
                    {isEditing && (
                      <button
                        onClick={() => {
                          subtasksApi.delete(subtask.id).then(() => {
                            handleSubtasksChange(subtasks.filter(s => s.id !== subtask.id));
                          });
                        }}
                        className="text-xs text-red-500 hover:text-red-600"
                      >
                        {t('taskModal.delete')}
                      </button>
                    )}
                  </div>
                ))}
                {subtasks.length === 0 && (
                  <p className="text-sm text-zinc-400">{t('taskModal.noSubtasks')}</p>
                )}
              </div>
            </div>

            {/* Attachments */}
            <div className="mt-6">
              <h4 className="mb-3 text-sm font-semibold text-zinc-600">
                {t('taskModal.attachments')} ({attachments.length})
              </h4>
              {loadingAttachments ? (
                <div className="text-sm text-zinc-400">{t('taskModal.loading')}</div>
              ) : attachments.length > 0 ? (
                <AttachmentList
                  attachments={attachments}
                  onDelete={canEdit ? handleDeleteAttachment : undefined}
                  canDelete={canEdit}
                />
              ) : (
                <p className="text-sm text-zinc-400">{t('taskModal.noAttachments')}</p>
              )}
              {uploadingInProgress && (
                <p className="mt-2 text-sm text-blue-500">{t('taskModal.uploading')}</p>
              )}
            </div>
          </div>

          {/* Comments Sidebar - 1/3 width */}
          <div className="w-1/3 min-w-80 border-l border-zinc-100 dark:border-zinc-700 flex flex-col">
            <div className="flex-shrink-0 p-4 pb-2 border-b border-zinc-100 dark:border-zinc-700 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">{t('taskModal.comments')} ({taskComments?.length || 0})</h4>
              {taskComments && taskComments.length > COMMENTS_PER_PAGE && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500">
                  {commentsPage} / {Math.ceil(taskComments.length / COMMENTS_PER_PAGE)}
                </span>
              )}
            </div>
            <div ref={commentsRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {(taskComments || []).slice((commentsPage - 1) * COMMENTS_PER_PAGE, commentsPage * COMMENTS_PER_PAGE).map((comment) => (
                <div key={comment.id} className="rounded-lg bg-zinc-50 dark:bg-zinc-700/50 p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <UserAvatar username={comment.author} size="sm" />
                    <span className="font-medium text-sm text-zinc-700 dark:text-zinc-200">{comment.author}</span>
                    <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500">{formatCommentDate(t, comment.createdAt)}</span>
                  </div>
                  <div className="prose prose-sm max-w-none text-zinc-600 dark:text-zinc-300">
                    <SafeMarkdown>{comment.content}</SafeMarkdown>
                  </div>
                  {/* Comment attachments */}
                  {attachments.filter(a => a.commentId === comment.id).length > 0 && (
                    <div className="mt-2">
                      <AttachmentList
                        attachments={attachments.filter(a => a.commentId === comment.id)}
                        onDelete={undefined}
                        canDelete={false}
                      />
                    </div>
                  )}
                </div>
              ))}
              {taskComments && taskComments.length > COMMENTS_PER_PAGE && (
                <div className="flex justify-center gap-2 pt-2">
                  <button
                    onClick={() => { setCommentsPage(p => Math.max(1, p - 1)); commentsRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
                    disabled={commentsPage === 1}
                    className="px-3 py-1 text-xs rounded bg-zinc-100 text-zinc-600 hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('taskModal.previousPage')}
                  </button>
                  <button
                    onClick={() => { setCommentsPage(p => Math.min(Math.ceil(taskComments!.length / COMMENTS_PER_PAGE), p + 1)); commentsRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
                    disabled={commentsPage >= Math.ceil(taskComments.length / COMMENTS_PER_PAGE)}
                    className="px-3 py-1 text-xs rounded bg-zinc-100 text-zinc-600 hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('taskModal.nextPage')}
                  </button>
                </div>
              )}

            </div>
            {/* Comment Input - Fixed at bottom */}
            <div className="flex-shrink-0 p-4 border-t border-zinc-100 dark:border-zinc-700 space-y-2">
              {currentUser ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">{t('taskModal.commentIdentity', { name: currentUser.nickname })}</div>
              ) : (
                <input
                  type="text"
                  value={commentAuthor}
                  onChange={(e) => handleAuthorChange(e.target.value)}
                  placeholder={t('taskModal.yourName')}
                  className="w-full rounded-md border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200"
                />
              )}
              
              {isEditing && (
                <div
                  id="comment-editor"
                  ref={commentEditorRef}
                  className="rounded-lg border border-zinc-200 overflow-y-auto"
                    onPaste={(e) => handleEditorPaste(e, 'comment')}
                    onDrop={(e) => handleEditorDrop(e, 'comment')}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <Suspense fallback={<textarea id="comment-input" aria-label={t('taskModal.addComment')} className="w-full rounded-lg border border-zinc-200 px-3 py-2 font-mono text-sm resize-none" style={{ height: 120 }} disabled />}>
                    <MarkdownEditor
                      value={newComment}
                      onChange={(val) => setNewComment(val || '')}
                      height={120}
                      id="comment-input"
                      aria-label={t('taskModal.addComment')}
                    />
                  </Suspense>
                </div>
              )}
              
              {!isEditing && (
                <>
                  <label htmlFor="comment-input" className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {t('taskModal.addComment')}
                  </label>
                  <textarea
                    id="comment-input"
                    name="comment-input"
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder={`${t('taskModal.addComment')} ${t('taskModal.commentHint')}`}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm resize-none"
                  />
                </>
              )}
              
              <div className="flex gap-2">
                <button
                  onClick={handleAddComment}
                  disabled={!newComment.trim() || (!isEditing && !currentUser && !commentAuthor.trim())}
                  className="flex-1 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
                >
                  {t('taskModal.send')}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-700 px-6 py-4">
          {isEditing ? (
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
              >
                {t('taskModal.save')}
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="rounded-md bg-zinc-200 dark:bg-zinc-700 px-4 py-2 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600"
              >
                {t('taskModal.cancel')}
              </button>
            </div>
          ) : canEdit ? (
            <div className="flex gap-3">
              <button
                onClick={() => onArchive(task.id)}
                className="text-sm text-orange-500 hover:text-orange-600"
              >
                {t('taskModal.archive')}
              </button>
              <button
                onClick={handleDelete}
                className="text-sm text-red-500 hover:text-red-600"
              >
                {t('taskModal.delete')}
              </button>
            </div>
          ) : (
            <span className="text-sm text-zinc-400 dark:text-zinc-500">{t('taskModal.completedNotEditable')}</span>
          )}
        </div>
      </div>

      {showAddSubtaskModal && (
        <AddSubtaskModal
          isOpen={showAddSubtaskModal}
          onClose={() => setShowAddSubtaskModal(false)}
          onSubmit={(title) => {
            subtasksApi.create({ taskId: task.id, title })
              .then((newSubtask) => {
                handleSubtasksChange([...subtasks, newSubtask]);
              });
            setShowAddSubtaskModal(false);
          }}
        />
      )}

      {showDeleteConfirmModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowDeleteConfirmModal(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold text-zinc-800">{t('taskModal.confirmDeleteTitle')}</h3>
            <p className="mb-6 text-sm text-zinc-600">{t('taskModal.confirmDelete')}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirmModal(false)}
                className="flex-1 rounded-md bg-zinc-100 px-4 py-2.5 text-base font-medium text-zinc-700 hover:bg-zinc-200"
              >
                {t('taskModal.cancel')}
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 rounded-md bg-red-500 px-4 py-2.5 text-base font-medium text-white hover:bg-red-600"
              >
                {t('taskModal.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
