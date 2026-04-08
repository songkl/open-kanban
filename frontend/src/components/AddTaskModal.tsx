import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { columnsApi } from '@/services/api';
import { CustomDropdown } from './CustomDropdown';
import type { Column } from '@/types/kanban';

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
}

export function AddTaskModal({
  isOpen,
  defaultColumnId,
  currentBoardId,
  boards = [],
  onClose,
  onSubmit,
}: AddTaskModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublished, setIsPublished] = useState(true);
  const [selectedBoardId, setSelectedBoardId] = useState(currentBoardId || '');
  const [columns, setColumns] = useState<Column[]>([]);
  const [selectedColumnId, setSelectedColumnId] = useState('');
  const [priority, setPriority] = useState('medium');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descEditorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedBoardId && isOpen) {
      columnsApi.getByBoard(selectedBoardId).then((data) => {
        setColumns(data);
        if (defaultColumnId && data.some((c) => c.id === defaultColumnId)) {
          setSelectedColumnId(defaultColumnId);
        } else {
          const todoCol = data.find((c) => c.status === 'todo');
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
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [currentBoardId]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose();
      return;
    }

    const target = e.target as HTMLElement;

    if (e.key === 'Tab' && target === titleInputRef.current) {
      e.preventDefault();
      const focusTarget = descEditorRef.current?.querySelector<HTMLElement>('textarea');
      focusTarget?.focus();
      return;
    }

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

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

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

      <div className="relative z-10 w-full max-w-2xl rounded-xl bg-white dark:bg-zinc-800 p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('task.addTask')}</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('task.titlePlaceholder')}
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-4 py-3 text-base focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('taskModal.description')}</label>
            <div ref={descEditorRef} className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
              <Suspense fallback={<textarea className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 font-mono text-sm resize-none dark:bg-zinc-700 dark:text-zinc-100" style={{ height: 250 }} disabled />}>
                <MarkdownEditor
                  value={description}
                  onChange={(val) => setDescription(val || '')}
                  height={250}
                />
              </Suspense>
            </div>
          </div>

          {boards.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('task.selectBoard')}</label>
              <select
                value={selectedBoardId}
                onChange={(e) => setSelectedBoardId(e.target.value)}
                className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm dark:bg-zinc-700 dark:text-zinc-100"
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {columns.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('task.selectColumn')}</label>
              <select
                value={selectedColumnId}
                onChange={(e) => setSelectedColumnId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const currentIndex = columns.findIndex((c) => c.id === selectedColumnId);
                    let nextIndex;
                    if (e.key === 'ArrowDown') {
                      nextIndex = currentIndex < columns.length - 1 ? currentIndex + 1 : 0;
                    } else {
                      nextIndex = currentIndex > 0 ? currentIndex - 1 : columns.length - 1;
                    }
                    setSelectedColumnId(columns[nextIndex].id);
                  }
                }}
                className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm dark:bg-zinc-700 dark:text-zinc-100"
              >
                {columns.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name}
                    </option>
                  ))}
              </select>
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
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('taskModal.priority')}</label>
            <CustomDropdown
              value={priority}
              options={[
                { value: 'low', label: t('taskModal.priorityLow') },
                { value: 'medium', label: t('taskModal.priorityMedium') },
                { value: 'high', label: t('taskModal.priorityHigh') },
              ]}
              onChange={setPriority}
              className="w-full"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-700 px-4 py-2.5 text-base font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600"
            >
              {t('task.cancel')}
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="flex-1 rounded-md bg-blue-500 px-4 py-2.5 text-base font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300 dark:disabled:bg-zinc-600"
            >
              {t('task.add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
