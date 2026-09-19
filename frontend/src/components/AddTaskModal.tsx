import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { columnsApi, attachmentsApi, authApi } from '@/services/api';
import type { Attachment, Agent, User } from '@/types/kanban';
import { CustomDropdown } from './CustomDropdown';
import { useFocusTrap } from '@/hooks/useFocusTrap';

const MarkdownEditor = lazy(() => import('@/components/MarkdownEditor'));

interface Board {
  id: string;
  name: string;
}

interface AddTaskModalProps {
  isOpen: boolean;
  defaultColumnId?: string;
  currentBoardId?: string;
  boards?: Board[];
  onClose: () => void;
  onSubmit: (
    title: string,
    description: string,
    published: boolean,
    columnId?: string,
    boardId?: string,
    priority?: string,
    extra?: { dueAt?: string | null; assignee?: string | null; attachmentIds?: string[] },
  ) => void;
  canCreateTaskInColumn?: (columnId: string) => boolean;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

// toDateInputValue / fromDateInputValue normalise between the
// `<input type="datetime-local">` wire shape (local time, no
// timezone suffix) and the ISO-8601 / RFC3339 the backend stores
// in tasks.due_at. The browser is always treated as the operator's
// local zone so the picker never silently shifts the deadline.
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

export function AddTaskModal({
  isOpen,
  defaultColumnId,
  currentBoardId,
  boards = [],
  onClose,
  onSubmit,
  canCreateTaskInColumn,
}: AddTaskModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublished, setIsPublished] = useState(true);
  const [selectedBoardId, setSelectedBoardId] = useState(currentBoardId || '');
  const [columns, setColumns] = useState<{ id: string; name: string }[]>([]);
  const [selectedColumnId, setSelectedColumnId] = useState('');
  const [priority, setPriority] = useState('medium');
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string>('');
  const [assigneeCandidates, setAssigneeCandidates] = useState<{ value: string; label: string }[]>([]);
  const [assigneesFailed, setAssigneesFailed] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descEditorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedColumnAllowed =
    !canCreateTaskInColumn || !selectedColumnId || canCreateTaskInColumn(selectedColumnId);

  useEffect(() => {
    if (selectedBoardId && isOpen) {
      columnsApi.getByBoard(selectedBoardId).then((data) => {
        setColumns(data);
        if (defaultColumnId && data.some((c) => c.id === defaultColumnId)) {
          setSelectedColumnId(defaultColumnId);
        } else {
          const todoCol = data.find((c) => c.name === t('task.status.todo'));
          setSelectedColumnId(todoCol?.id || data[0]?.id || '');
        }
      });
    }
  }, [selectedBoardId, isOpen, defaultColumnId, t]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setAssigneesFailed(false);
    Promise.all([
      authApi.listVisibleUsers(currentBoardId).catch(() => []),
      authApi.getAgents().catch(() => []),
    ])
      .then(([people, agents]) => {
        if (cancelled) return;
        const opts: { value: string; label: string }[] = [];
        const dedupe = new Set<string>();
        for (const p of people as User[]) {
          const v = p.id;
          if (!v || dedupe.has(v)) continue;
          dedupe.add(v);
          opts.push({ value: v, label: p.nickname || p.id });
        }
        for (const a of agents as Agent[]) {
          if (!a.id || dedupe.has(a.id)) continue;
          dedupe.add(a.id);
          opts.push({ value: a.id, label: `${a.nickname} (agent)` });
        }
        setAssigneeCandidates(opts);
      })
      .catch(() => {
        if (!cancelled) setAssigneesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, currentBoardId]);

  const resetForm = useCallback(() => {
    setTitle('');
    setDescription('');
    setIsPublished(true);
    setSelectedBoardId(currentBoardId || '');
    setPriority('medium');
    setDueAt(null);
    setAssignee('');
    setAttachments([]);
    setAttachmentError(null);
  }, [currentBoardId]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const dialogRef = useFocusTrap<HTMLDivElement>({
    enabled: isOpen,
    initialFocus: 'first',
    onEscape: handleClose,
    restoreFocus: true,
  });

  const buildPayload = useCallback(() => ({
    dueAt,
    assignee: assignee || null,
    attachmentIds: attachments.map((a) => a.id),
  }), [dueAt, assignee, attachments]);

  const submitWith = useCallback((publishedValue: boolean) => {
    if (!title.trim()) return;
    onSubmit(
      title.trim(),
      description.trim(),
      publishedValue,
      selectedColumnId,
      selectedBoardId,
      priority,
      buildPayload(),
    );
    setTitle('');
    setDescription('');
    setIsPublished(false);
    handleClose();
  }, [title, description, selectedColumnId, selectedBoardId, priority, buildPayload, onSubmit, handleClose]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitWith(isPublished);
        return;
      }
      if (e.key === 's') {
        e.preventDefault();
        submitWith(false);
        return;
      }
    }
  }, [submitWith, isPublished]);

  const handleKeyDownRef = useRef(handleKeyDown);
  useEffect(() => {
    handleKeyDownRef.current = handleKeyDown;
  }, [handleKeyDown]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => handleKeyDownRef.current(e);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitWith(isPublished);
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setAttachmentError(null);
    const next: Attachment[] = [];
    let firstError: string | null = null;
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_SIZE) {
        firstError = t('taskModal.attachmentUploadFailed', { name: file.name });
        continue;
      }
      if (!ALLOWED_TYPES.includes(file.type)) {
        firstError = t('taskModal.attachmentUploadFailed', { name: file.name });
        continue;
      }
      try {
        const { promise } = attachmentsApi.upload(file);
        const uploaded = await promise;
        next.push(uploaded);
      } catch (err) {
        console.error('Upload failed', err);
        firstError = t('taskModal.attachmentUploadFailed', { name: file.name });
      }
    }
    if (next.length > 0) {
      setAttachments((prev) => [...prev, ...next]);
    }
    if (firstError) setAttachmentError(firstError);
    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-task-modal-title"
        className="relative z-10 w-full max-w-2xl rounded-xl bg-white dark:bg-zinc-800 p-6 shadow-xl outline-none"
      >
        <h2 id="add-task-modal-title" className="mb-4 text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('task.addTask')}</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="add-task-title" className="sr-only">{t('task.titlePlaceholder')}</label>
            <input
              ref={titleInputRef}
              id="add-task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('task.titlePlaceholder')}
              aria-label={t('task.titlePlaceholder')}
              aria-required="true"
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-4 py-3 text-base focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-400">{t('taskModal.description')}</label>
            <div ref={descEditorRef} className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
              <Suspense fallback={<textarea aria-label={t('taskModal.description')} className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 font-mono text-sm resize-none dark:bg-zinc-700 dark:text-zinc-100" style={{ height: 250 }} disabled />}>
                <MarkdownEditor
                  value={description}
                  onChange={(val) => setDescription(val || '')}
                  height={250}
                  aria-label={t('taskModal.description')}
                />
              </Suspense>
            </div>
          </div>

          {(boards.length > 0 || columns.length > 0) && (
            <div className="grid grid-cols-2 gap-4">
              {boards.length > 0 && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-400">{t('task.selectBoard')}</label>
                  <CustomDropdown
                    options={boards.map(board => ({ value: board.id, label: board.name }))}
                    value={selectedBoardId}
                    onChange={setSelectedBoardId}
                    className="w-full"
                  />
                </div>
              )}

              {columns.length > 0 && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-400">{t('task.selectColumn')}</label>
                  <CustomDropdown
                    options={columns.map(col => ({ value: col.id, label: col.name }))}
                    value={selectedColumnId}
                    onChange={setSelectedColumnId}
                    className="w-full"
                  />
                  {!selectedColumnAllowed && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      {t('column.noAddPermission')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={isPublished}
              onChange={(e) => setIsPublished(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-200 dark:border-zinc-600 dark:bg-zinc-700"
            />
            {t('task.publishHint')}
          </label>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-400">{t('taskModal.priority')}</label>
            <CustomDropdown
              options={[
                { value: 'low', label: t('taskModal.priorityLow') },
                { value: 'medium', label: t('taskModal.priorityMedium') },
                { value: 'high', label: t('taskModal.priorityHigh') },
              ]}
              value={priority}
              onChange={setPriority}
              className="w-full"
            />
          </div>

          <div>
            <label htmlFor="add-task-due-at" className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-400">
              {t('taskModal.dueDateFieldLabel')}
            </label>
            <input
              id="add-task-due-at"
              type="datetime-local"
              value={toDateInputValue(dueAt)}
              onChange={(e) => setDueAt(fromDateInputValue(e.target.value))}
              aria-describedby="add-task-due-at-hint"
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
            />
            <p id="add-task-due-at-hint" className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {t('taskModal.dueDatePickerHint')}
            </p>
            {dueAt && (
              <button
                type="button"
                onClick={() => setDueAt(null)}
                className="mt-1 text-xs text-blue-500 hover:text-blue-600"
              >
                {t('taskModal.dueDateClear')}
              </button>
            )}
          </div>

          <div>
            <label htmlFor="add-task-assignee" className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-400">
              {t('taskModal.assignee')}
            </label>
            <select
              id="add-task-assignee"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
            >
              <option value="">{t('taskModal.unassigned')}</option>
              {assigneeCandidates.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {assigneesFailed && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t('taskModal.assigneeLoadFailed')}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-400">
              {t('taskModal.addAttachment')}
            </label>
            <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
              {t('taskModal.attachmentHint')}
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              data-testid="add-task-attachments-input"
              onChange={handleFilePick}
              className="block w-full text-sm text-zinc-700 dark:text-zinc-200 file:mr-3 file:rounded-md file:border-0 file:bg-blue-500 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-blue-600"
            />
            {isUploading && (
              <p className="mt-1 text-xs text-blue-500">{t('taskModal.attachmentUploadProgress', { name: '...' })}</p>
            )}
            {attachmentError && (
              <p className="mt-1 text-xs text-red-500" data-testid="add-task-attachments-error">{attachmentError}</p>
            )}
            {attachments.length > 0 && (
              <ul className="mt-2 space-y-1" data-testid="add-task-attachments-list">
                {attachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between rounded-md bg-zinc-50 dark:bg-zinc-700/50 px-3 py-1.5 text-sm"
                  >
                    <span className="truncate text-zinc-700 dark:text-zinc-200" title={a.filename}>
                      {a.filename}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(a.id)}
                      className="ml-3 text-xs text-red-500 hover:text-red-600"
                      aria-label={t('taskModal.removeAttachment')}
                    >
                      {t('taskModal.removeAttachment')}
                    </button>
                  </li>
                ))}
                <li className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t('taskModal.attachmentsUploaded', { count: attachments.length })}
                </li>
              </ul>
            )}
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-700 px-4 py-2.5 text-base font-medium text-zinc-700 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-600"
            >
              {t('task.cancel')}
            </button>
            <button
              type="submit"
              disabled={!title.trim() || !selectedColumnAllowed}
              title={!selectedColumnAllowed ? t('column.noAddPermission') : undefined}
              className="flex-1 rounded-md bg-blue-500 px-4 py-2.5 text-base font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300 dark:disabled:bg-zinc-600 disabled:cursor-not-allowed"
            >
              {t('task.add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}