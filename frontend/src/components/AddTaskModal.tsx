import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { columnsApi } from '@/services/api';
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
  onSubmit: (title: string, description: string, published: boolean, columnId?: string, boardId?: string, priority?: string) => void;
  canCreateTaskInColumn?: (columnId: string) => boolean;
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
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descEditorRef = useRef<HTMLDivElement>(null);

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

  const resetForm = useCallback(() => {
    setTitle('');
    setDescription('');
    setIsPublished(true);
    setSelectedBoardId(currentBoardId || '');
    setPriority('medium');
  }, [currentBoardId]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  // s-1199: trap Tab focus inside the dialog and route Escape to
  // handleClose. The hook also restores focus to whatever the user
  // had focused before opening the modal.
  const dialogRef = useFocusTrap<HTMLDivElement>({
    enabled: isOpen,
    initialFocus: 'first',
    onEscape: handleClose,
    restoreFocus: true,
  });

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (title.trim()) {
          onSubmit(title.trim(), description.trim(), isPublished, selectedColumnId, selectedBoardId, priority);
          setTitle('');
          setDescription('');
          setIsPublished(false);
          handleClose();
        }
        return;
      }

      if (e.key === 's') {
        e.preventDefault();
        if (title.trim()) {
          onSubmit(title.trim(), description.trim(), false, selectedColumnId, selectedBoardId, priority);
          setTitle('');
          setDescription('');
          setIsPublished(false);
          handleClose();
        }
        return;
      }
    }
  }, [handleClose, title, description, isPublished, selectedColumnId, selectedBoardId, priority, onSubmit]);

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
    if (title.trim()) {
      onSubmit(title.trim(), description.trim(), isPublished, selectedColumnId, selectedBoardId, priority);
      setTitle('');
      setDescription('');
      setIsPublished(false);
      handleClose();
    }
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
