import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { SafeMarkdown } from './SafeMarkdown';
import { UserAvatar } from './UserAvatar';
import { useTaskRun } from '../hooks/useTaskRun';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useCustomFields } from '../hooks/useCustomFields';
import type { TaskRun, CustomField } from '@/types/kanban';
import type { Task, Attachment, Column, Agent, Subtask, Comment } from '@/types/kanban';

const MarkdownEditor = lazy(() => import('@/components/MarkdownEditor'));
import { columnsApi, subtasksApi, attachmentsApi, authApi, commentsApi } from '@/services/api';
import { AttachmentList } from './AttachmentList';
import { AddSubtaskModal } from './AddSubtaskModal';
import { RunTimeline } from './RunTimeline';
import { CustomFieldEditor } from './CustomFieldEditor';

const STORAGE_KEY = 'kanban-username';

function toDateInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

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

/**
 * Format the elapsed time since `claimedAt` into a short human label.
 * Kept short to fit the run info section header — see TaskCard for the
 * badge variant.
 *
 * When `finishedAt` is supplied (i.e. the run has reached a terminal
 * status) the elapsed label is frozen at `finishedAt - claimedAt` so
 * the modal does not keep ticking once the runner has settled.
 */
function formatRunElapsed(
  claimedAt: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  finishedAt?: string | null
): string {
  const startMs = new Date(claimedAt).getTime();
  if (Number.isNaN(startMs)) return t('taskCard.runnerElapsedSeconds', { count: 0 });
  const endMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (elapsedSec < 60) return t('taskCard.runnerElapsedSeconds', { count: elapsedSec });
  if (elapsedSec < 3600) {
    return t('taskCard.runnerElapsedMinutes', { count: Math.floor(elapsedSec / 60) });
  }
  return t('taskCard.runnerElapsedHours', { count: Math.floor(elapsedSec / 3600) });
}

/**
 * RunInfoSection — banner shown inside the task modal while a CLI
 * runner holds the task. Mirrors the polling logic in TaskCard (see
 * `devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §5) but exposes the full row
 * — runner id, agent id, status, timestamps — since the modal has
 * room for it. The elapsed label re-renders once a second so it
 * doesn't have to round-trip the API on every tick.
 */
function RunInfoSection({ run }: { run: TaskRun }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'zh' ? 'zh-CN' : i18n.language;
  const dateFmt = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  // Only tick once a second while the runner is live — once the run
  // settles into a terminal status (`completed` / `failed` /
  // `released`) the elapsed label is frozen at `finishedAt` so the
  // modal stops re-rendering for a runner that has already gone
  // away (s-1168).
  const isLive = run.status === 'claimed' || run.status === 'running';
  const [, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isLive) return undefined;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [isLive]);

  const statusColor: Record<TaskRun['status'], string> = {
    claimed: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-700/50',
    running: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 border-violet-200 dark:border-violet-700/50',
    completed: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-700/50',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-700/50',
    released: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-600',
  };

  return (
    <div
      className="mb-6 rounded-lg border border-violet-200 dark:border-violet-700/50 bg-violet-50/50 dark:bg-violet-900/20 p-4"
      data-testid="task-run-info"
    >
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <span aria-hidden className="text-base">🤖</span>
        <h4 className="text-sm font-semibold text-violet-700 dark:text-violet-300">
          {t('taskModal.runInfo')}
        </h4>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusColor[run.status]}`}
          data-testid="run-status"
        >
          {t(`taskModal.runStatus.${run.status}`)}
        </span>
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
          {t('taskModal.runElapsed', { elapsed: formatRunElapsed(run.claimedAt, t, run.finishedAt ?? null) })}
        </span>
      </div>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runRunner')}</dt>
        <dd className="font-mono text-zinc-700 dark:text-zinc-200 break-all" title={run.runnerId}>{run.runnerId}</dd>

        <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runAgent')}</dt>
        <dd className="font-mono text-zinc-700 dark:text-zinc-200 break-all">{run.agentId || '—'}</dd>

        <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runClaimedAt')}</dt>
        <dd className="text-zinc-700 dark:text-zinc-200">{dateFmt.format(new Date(run.claimedAt))}</dd>

        <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runLastHeartbeat')}</dt>
        <dd className="text-zinc-700 dark:text-zinc-200">{dateFmt.format(new Date(run.lastHeartbeatAt))}</dd>

        <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runExpiresAt')}</dt>
        <dd className="text-zinc-700 dark:text-zinc-200">{dateFmt.format(new Date(run.expiresAt))}</dd>

        {run.finishedAt && (
          <>
            <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runFinishedAt')}</dt>
            <dd className="text-zinc-700 dark:text-zinc-200">{dateFmt.format(new Date(run.finishedAt))}</dd>
          </>
        )}
        {run.exitCode !== undefined && run.exitCode !== null && (
          <>
            <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runExitCode')}</dt>
            <dd className="font-mono text-zinc-700 dark:text-zinc-200">{run.exitCode}</dd>
          </>
        )}
        {run.output && (
          <>
            <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runOutput')}</dt>
            <dd className="whitespace-pre-wrap break-words font-mono text-zinc-700 dark:text-zinc-200 max-h-60 overflow-auto rounded bg-zinc-100/60 dark:bg-zinc-900/40 p-2">
              {run.output}
            </dd>
          </>
        )}
        {run.error && (
          <>
            <dt className="text-zinc-500 dark:text-zinc-400">{t('taskModal.runError')}</dt>
            <dd className="whitespace-pre-wrap break-words font-mono text-red-600 dark:text-red-400 max-h-60 overflow-auto rounded bg-red-50/60 dark:bg-red-950/30 p-2">
              {run.error}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
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
  /**
   * s-1197: pre-loaded custom field definitions. When omitted, the
   * modal falls back to its own `useCustomFields(boardId)` lookup so
   * other entry points (ColumnDetailPage, etc.) get the chips too.
   * Passing them in avoids a redundant localStorage read.
   */
  customFields?: CustomField[];
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
  customFields: customFieldsProp,
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
    }
  }, [startEditing, isEditing]);

  useEffect(() => {
    if (isEditing && startEditing) {
      onEditingStarted?.();
    }
  }, [isEditing, startEditing, onEditingStarted]);

  useEffect(() => {
    if (isEditing && startEditing) {
      const timer = setTimeout(() => titleInputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [isEditing, startEditing]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
        const fieldOrder = [
          titleInputRef,
          statusSelectRef,
          prioritySelectRef,
          assigneeSelectRef,
          metaKeyInputRef,
        ];
        const currentIndex = fieldOrder.findIndex(ref => ref.current === e.target);
        if (currentIndex !== -1) {
          const nextIndex = e.shiftKey
            ? (currentIndex - 1 + fieldOrder.length) % fieldOrder.length
            : (currentIndex + 1) % fieldOrder.length;
          fieldOrder[nextIndex]?.current?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isEditing]);

  const [editDesc, setEditDesc] = useState(task.description || '');
  const [editPriority, setEditPriority] = useState(task.priority);
  const [editAssignee, setEditAssignee] = useState(task.assignee || '');
  const [editDueAt, setEditDueAt] = useState<string | null>(task.dueAt ?? null);
  const [editAgentId, setEditAgentId] = useState(task.agentId || '');
  const [editAgentPrompt, setEditAgentPrompt] = useState(task.agentPrompt || '');
  const [editMeta, setEditMeta] = useState<Record<string, unknown>>({});
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

  // s-1199: focus trap so keyboard users can Tab through the drawer
  // without leaking focus to the underlying board. Escape is handled
  // by the trap (calls onClose); focus is restored to whatever the
  // user clicked when the drawer opened.
  const dialogRef = useFocusTrap<HTMLDivElement>({
    enabled: true,
    initialFocus: 'first',
    onEscape: onClose,
    restoreFocus: true,
  });
  const [commentsPage, setCommentsPage] = useState(1);
  const [taskComments, setTaskComments] = useState<Comment[]>(task.comments ?? []);
  const COMMENTS_PER_PAGE = 10;
  const [isFullscreen, setIsFullscreen] = useState(false);

  const parseMeta = (metaStr: string | Record<string, unknown> | null): Record<string, unknown> => {
    if (!metaStr) return {};
    if (typeof metaStr === 'object' && metaStr !== null) return metaStr as Record<string, unknown>;
    if (typeof metaStr === 'string') {
      try {
        const parsed = JSON.parse(metaStr);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  };

  // s-1197: prefer the prop-injected list (avoids re-reading
  // localStorage); fall back to the per-board lookup for entry points
  // that don't pipe it through (e.g. ColumnDetailPage). When no board
  // is loaded yet, both paths return [] and the editor self-hides.
  const { customFields: ownCustomFields } = useCustomFields(boardId);
  const customFields = customFieldsProp ?? ownCustomFields;

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
    setEditDueAt(task.dueAt ?? null);
  }, [task.id, task.dueAt]);

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

  const lastTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!task.id) return;
    if (lastTaskIdRef.current !== task.id) {
      lastTaskIdRef.current = task.id;
      setCommentsPage(1);
      if (task.comments && task.comments.length > 0) {
        setTaskComments(task.comments);
      } else {
        commentsApi.getByTask(task.id)
          .then((data) => setTaskComments(data || []))
          .catch(console.error);
      }
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

  // Poll for the live CLI runner on this task. The run section only
  // renders when the server returns a row — same semantics as the
  // card badge in TaskCard, just with more detail.
  const { run } = useTaskRun(task.id, { intervalMs: 5000 });

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
        dueAt: editDueAt,
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
  }, [task, editTitle, editDesc, editPriority, editAssignee, editDueAt, editMeta, editColumn, editAgentId, editAgentPrompt, onUpdate]);

  useEffect(() => {
    const deps = [task, editTitle, editDesc, editPriority, editAssignee, editDueAt, editMeta, editColumn, editAgentId, editAgentPrompt, onUpdate];
    if (handleSaveRefDeps.current.join() !== deps.join()) {
      handleSaveRef.current = handleSave;
      handleSaveRefDeps.current = deps;
    }
  });

  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    const trimmed = newComment.trim();
    const optimisticComment: Comment = {
      id: `temp-${Date.now()}`,
      content: trimmed,
      author: commentAuthor,
      taskId: task.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setTaskComments((prev) => {
      const next = [...prev, optimisticComment];
      const totalPages = Math.max(1, Math.ceil(next.length / COMMENTS_PER_PAGE));
      setCommentsPage(totalPages);
      return next;
    });
    onAddComment(task.id, trimmed, commentAuthor);
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
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/70 overflow-y-auto ${isFullscreen ? 'p-0' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-modal-title"
        className={`relative z-10 flex flex-col bg-white dark:bg-zinc-800 rounded-xl shadow-xl outline-none overflow-hidden ${isFullscreen ? 'w-screen h-screen max-w-full max-h-full rounded-none' : 'h-full max-h-[calc(100vh-4rem)] my-8 mx-auto max-w-7xl'}`}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between border-b border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <div className="flex items-center gap-3 flex-wrap">
            {/*
              Single source of truth for the status pill. PM_REVIEW_2026-09-17
              §3.6 finding #1 (s-1190): the column name (e.g. "已完成") must
              be hidden whenever a live/terminal task_runs row exists, so the
              drawer never shows both "🤖 运行中" and "已完成" on the same
              row. The run status badge is rendered inside RunInfoSection
              below and re-renders the single canonical state.
            */}
            {columnName && !run && (
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-700 px-3 py-1 text-sm text-zinc-600 dark:text-zinc-300">
                {columnName}
              </span>
            )}
            {!isEditing && (
              <div>
                <h2 id="task-modal-title" className="text-xl font-bold text-zinc-800 dark:text-zinc-100">{task.title}</h2>
                <div className="mt-1 flex items-center gap-4 text-xs text-zinc-400 dark:text-zinc-400">
                  {(task.createdByNickname || task.createdByUsername) && (
                    <div
                      className="flex items-center gap-1.5"
                      title={`${t('taskModal.createdBy')}: ${task.createdByNickname || task.createdByUsername}`}
                    >
                      <UserAvatar
                        username={task.createdByNickname || task.createdByUsername || ''}
                        avatar={task.createdByAvatar}
                        size="sm"
                      />
                      <span className="font-medium text-zinc-600 dark:text-zinc-300">
                        {task.createdByNickname || task.createdByUsername}
                      </span>
                    </div>
                  )}
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
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(task.id);
              }}
              title={t('taskModal.copyTaskId')}
              aria-label={t('taskModal.copyTaskId')}
              className="rounded-md p-1.5 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 dark:bg-zinc-700 hover:text-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={t('taskModal.fullscreen')}
              aria-label={isFullscreen ? t('taskModal.exitFullscreen') : t('taskModal.fullscreen')}
              aria-pressed={isFullscreen}
              className="rounded-md p-1.5 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 dark:bg-zinc-700 hover:text-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              {isFullscreen ? (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t('common.close')}
              aria-label={t('common.close')}
              className="rounded-md p-1 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 dark:bg-zinc-700 hover:text-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* s-1193: persistent CI-pipeline-style stepper in the drawer
            header. Sits below the title row so the operator sees the
            run timeline even when scrolled deep into the comment
            thread (PM_REVIEW_2026-09-17 §5.1 finding #2). */}
        {run && (
          <div className="flex-shrink-0 border-b border-zinc-100 dark:border-zinc-700 px-6 py-3">
            <RunTimeline run={run} />
          </div>
        )}

        <div className="flex flex-1 min-h-0">
          {/* Main Content */}
          <div className="flex-1 min-w-[28rem] overflow-y-auto p-6">
            {/* Title - only show input when editing, title is in header otherwise */}
            {isEditing && (
              <label className="mb-4 block">
                <span className="sr-only">{t('taskModal.titleField')}</span>
                <input
                  ref={titleInputRef}
                  id="task-title-input"
                  name="task-title-input"
                  type="text"
                  aria-label={t('taskModal.titleField')}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-4 py-2.5 text-xl font-semibold"
                />
              </label>
            )}

            {/* Run Info — only rendered while a CLI runner holds the task.
                Surfaced near the top of the modal so operators can see
                who is working on the task without scrolling. The run
                status badge here is the single source of truth — see the
                columnName suppression above. */}
            {run && <RunInfoSection run={run} />}

            {/* Description */}
            <div className="mb-6">
              <label htmlFor="task-modal-description" className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                {t('taskModal.description')} {isEditing && t('taskModal.descriptionHint')}
              </label>
              {isEditing ? (
                <div
                  id="desc-editor"
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-y-auto"
                  onPaste={(e) => handleEditorPaste(e, 'desc')}
                  onDrop={(e) => handleEditorDrop(e, 'desc')}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <Suspense fallback={<textarea aria-label={t('taskModal.description')} id="task-modal-description" className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 font-mono text-sm resize-none" style={{ height: 200 }} disabled />}>
                    <MarkdownEditor
                      value={editDesc}
                      onChange={(val) => setEditDesc(val || '')}
                      height={200}
                      id="task-modal-description"
                      aria-label={t('taskModal.description')}
                    />
                  </Suspense>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none rounded-lg bg-zinc-50 dark:bg-zinc-700/50 p-4">
                  {task.description ? (
                    <SafeMarkdown>{task.description}</SafeMarkdown>
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-400">{t('taskModal.noDescription')}</span>
                  )}
                </div>
              )}
            </div>

            {/* Run Info — only rendered while a CLI runner holds the task.
                Surfaced near the top of the modal so operators can see
                who is working on the task without scrolling. */}
            {run && <RunInfoSection run={run} />}

            {/* Grid Layout for Edit Mode */}
            {/* s-1202: surface assignee + last runner + due date explicitly in the
                drawer (read-only view) so the operator sees both fields
                without having to scroll into the Run info section. Mirrors
                the card footer chips: 👤 for assignee, 🤖 for runner, 📅
                for due date. PM_REVIEW_2026-09-17 §3.2 finding #3. T-1207 /
                s-1207 adds the due-date row so a task created with one
                surfaces it in the same place the assignee + runner already do. */}
            {!isEditing && (task.assignee || task.dueAt || (run && run.runnerId)) && (
              <div
                className="mb-6 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-700/40 px-4 py-3"
                data-testid="task-modal-people"
              >
                <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-xs">
                  {task.assignee && (
                    <>
                      <dt className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                        <span aria-hidden>👤</span>
                        <span>{t('taskModal.assigneeFieldLabel')}</span>
                      </dt>
                      <dd
                        className="text-zinc-700 dark:text-zinc-200"
                        data-testid="task-modal-assignee"
                      >
                        {task.assignee}
                      </dd>
                    </>
                  )}
                  {task.dueAt && (
                    <>
                      <dt className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                        <span aria-hidden>📅</span>
                        <span>{t('taskModal.dueDate')}</span>
                      </dt>
                      <dd
                        className="text-zinc-700 dark:text-zinc-200"
                        data-testid="task-modal-due-at"
                      >
                        {new Date(task.dueAt).toLocaleString()}
                      </dd>
                    </>
                  )}
                  {run && run.runnerId && (
                    <>
                      <dt className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                        <span aria-hidden>🤖</span>
                        <span>{t('taskModal.lastRunnerFieldLabel')}</span>
                      </dt>
                      <dd
                        className="font-mono text-zinc-700 dark:text-zinc-200 break-all"
                        title={run.runnerId}
                        data-testid="task-modal-last-runner"
                      >
                        {run.runnerId}
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            )}
            {isEditing && (
              <div className="mb-6 grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600 dark:text-zinc-300">{t('taskModal.status')}</label>
                  <select
                    ref={statusSelectRef}
                    value={editColumn}
                    onChange={(e) => setEditColumn(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                  >
                    {(allColumns.length > 0 ? allColumns : columns).map((col) => (
                      <option key={col.id} value={col.id}>{col.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600 dark:text-zinc-300">{t('taskModal.assignee')}</label>
                  <select
                    ref={assigneeSelectRef}
                    value={editAssignee}
                    onChange={(e) => setEditAssignee(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
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
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600 dark:text-zinc-300">{t('taskModal.priority')}</label>
                  <select
                    ref={prioritySelectRef}
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                  >
                    <option value="low">{t('taskModal.priorityLow')}</option>
                    <option value="medium">{t('taskModal.priorityMedium')}</option>
                    <option value="high">{t('taskModal.priorityHigh')}</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="task-modal-due-at" className="mb-1.5 block text-sm font-medium text-zinc-600 dark:text-zinc-300">
                    {t('taskModal.dueDate')}
                  </label>
                  <input
                    id="task-modal-due-at"
                    type="datetime-local"
                    value={toDateInputValue(editDueAt)}
                    onChange={(e) => setEditDueAt(fromDateInputValue(e.target.value))}
                    className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                  />
                  {editDueAt && (
                    <button
                      type="button"
                      onClick={() => setEditDueAt(null)}
                      className="mt-1 text-xs text-blue-500 hover:text-blue-600"
                    >
                      {t('taskModal.dueDateClear')}
                    </button>
                  )}
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600 dark:text-zinc-300">{t('taskModal.agentId')}</label>
                  <input
                    type="text"
                    value={editAgentId}
                    onChange={(e) => setEditAgentId(e.target.value)}
                    placeholder={t('taskModal.agentIdPlaceholder')}
                    className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                  />
                </div>

                <div className="col-span-2">
                  <label className="mb-1.5 block text-sm font-medium text-zinc-600 dark:text-zinc-300">{t('taskModal.agentPrompt')}</label>
                  <textarea
                    value={editAgentPrompt}
                    onChange={(e) => setEditAgentPrompt(e.target.value)}
                    placeholder={t('taskModal.agentPromptPlaceholder')}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 resize-none"
                  />
                </div>
              </div>
            )}

            {/* s-1197: typed custom-field editor. Renders nothing when no
                fields are defined for this board so legacy meta-only
                boards stay unchanged. */}
            {customFields.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-300">{t('customFields.editorTitle')}</h4>
                <CustomFieldEditor
                  customFields={customFields}
                  values={editMeta}
                  isEditing={isEditing}
                  onChange={(next) => setEditMeta(next)}
                />
              </div>
            )}

            {/* Meta — legacy free-form key/value editor. Kept as a
                fallback so existing users' metadata isn't dropped when
                a board hasn't opted into the typed editor yet. */}
            <div>
              <h4 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-300">{t('taskModal.meta')}</h4>
              <div className="space-y-2">
                {Object.entries(editMeta)
                  .filter(([key]) => !customFields.some(f => f.name === key))
                  .map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="min-w-[80px] text-sm">{key}:</span>
                    <span className="flex-1 text-sm">
                      {Array.isArray(value) ? value.join(', ') : String(value ?? '')}
                    </span>
                    {isEditing && (
                      <button
                        onClick={() => {
                          const newMeta = { ...editMeta };
                          delete newMeta[key];
                          setEditMeta(newMeta);
                        }}
                        className="text-xs text-red-500"
                      >
                        {t('common.deleteMeta')}
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
                      className="w-24 rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-sm"
                    />
                    <input
                      type="text"
                      value={newMetaValue}
                      onChange={(e) => setNewMetaValue(e.target.value)}
                      placeholder={t('taskModal.metaValue')}
                      className="flex-1 rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-sm"
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
                  <h4 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
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
                      className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600"
                    />
                    <span className={`flex-1 text-sm ${subtask.completed ? 'text-zinc-400 dark:text-zinc-500 line-through' : 'text-zinc-700 dark:text-zinc-400'}`}>
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
                  <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('taskModal.noSubtasks')}</p>
                )}
              </div>
            </div>

            {/* Attachments */}
            <div className="mt-6">
              <h4 className="mb-3 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                {t('taskModal.attachments')} ({attachments.length})
              </h4>
              {loadingAttachments ? (
                <div className="text-sm text-zinc-400 dark:text-zinc-500">{t('taskModal.loading')}</div>
              ) : attachments.length > 0 ? (
                <AttachmentList
                  attachments={attachments}
                  onDelete={canEdit ? handleDeleteAttachment : undefined}
                  canDelete={canEdit}
                />
              ) : (
                <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('taskModal.noAttachments')}</p>
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
                <span className="text-xs text-zinc-400 dark:text-zinc-400">
                  {commentsPage} / {Math.ceil(taskComments.length / COMMENTS_PER_PAGE)}
                </span>
              )}
            </div>
            <div ref={commentsRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {(taskComments || []).slice((commentsPage - 1) * COMMENTS_PER_PAGE, commentsPage * COMMENTS_PER_PAGE).map((comment) => (
                <div key={comment.id} className="rounded-lg bg-zinc-50 dark:bg-zinc-700/50 p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <UserAvatar username={comment.author} size="sm" />
                    <span className="font-medium text-sm text-zinc-700 dark:text-zinc-400">{comment.author}</span>
                    <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-400">{formatCommentDate(t, comment.createdAt)}</span>
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
                    className="px-3 py-1 text-xs rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('taskModal.previousPage')}
                  </button>
                  <button
                    onClick={() => { setCommentsPage(p => Math.min(Math.ceil(taskComments!.length / COMMENTS_PER_PAGE), p + 1)); commentsRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
                    disabled={commentsPage >= Math.ceil(taskComments.length / COMMENTS_PER_PAGE)}
                    className="px-3 py-1 text-xs rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('taskModal.nextPage')}
                  </button>
                </div>
              )}

            </div>
            {/* Comment Input - Fixed at bottom */}
            <div className="flex-shrink-0 p-4 border-t border-zinc-100 dark:border-zinc-700 space-y-2">
              {currentUser ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-500">{t('taskModal.commentIdentity', { name: currentUser.nickname })}</div>
              ) : (
                <input
                  type="text"
                  value={commentAuthor}
                  onChange={(e) => handleAuthorChange(e.target.value)}
                  placeholder={t('taskModal.yourName')}
                  className="w-full rounded-md border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-400"
                />
              )}
              
              {isEditing && (
                <div
                  id="comment-editor"
                  ref={commentEditorRef}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-y-auto"
                    onPaste={(e) => handleEditorPaste(e, 'comment')}
                    onDrop={(e) => handleEditorDrop(e, 'comment')}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <Suspense fallback={<textarea id="comment-input" aria-label={t('taskModal.addComment')} className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 font-mono text-sm resize-none" style={{ height: 120 }} disabled />}>
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
                  <label htmlFor="comment-input" className="text-sm font-medium text-zinc-700 dark:text-zinc-400">
                    {t('taskModal.addComment')}
                  </label>
                  <textarea
                    id="comment-input"
                    name="comment-input"
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder={`${t('taskModal.addComment')} ${t('taskModal.commentHint')}`}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm resize-none"
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
                className="rounded-md bg-zinc-200 dark:bg-zinc-700 px-4 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600"
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
            <span className="text-sm text-zinc-400 dark:text-zinc-400">{t('taskModal.completedNotEditable')}</span>
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center" role="presentation">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowDeleteConfirmModal(false)} />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="task-modal-delete-title"
            aria-describedby="task-modal-delete-desc"
            className="relative z-10 w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-6 shadow"
          >
            <h3 id="task-modal-delete-title" className="mb-2 text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('taskModal.confirmDeleteTitle')}</h3>
            <p id="task-modal-delete-desc" className="mb-6 text-sm text-zinc-600 dark:text-zinc-300">{t('taskModal.confirmDelete')}</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteConfirmModal(false)}
                className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-700 px-4 py-2.5 text-base font-medium text-zinc-700 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-600"
              >
                {t('taskModal.cancel')}
              </button>
              <button
                type="button"
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
