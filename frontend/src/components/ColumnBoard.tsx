import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Column } from './Column';
import { DragLayer } from './DragLayer';
import { AddTaskModal } from './AddTaskModal';
import type { Board, Column as ColumnType, Task } from '@/types/kanban';

const TaskModal = lazy(() => import('./TaskModal').then(m => ({ default: m.TaskModal })));

interface ColumnBoardProps {
  columns: ColumnType[];
  currentBoard: Board | null;
  boards: Board[];
  boardIdFromUrl: string;
  activeTask: Task | null;
  selectedTask: Task | null;
  selectedTasks: Set<string>;
  columnPagination: Record<string, { page: number; hasMore: boolean; isLoadingMore: boolean }>;
  filters: { searchQuery: string; priority: string; assignee: string; dateRange: string; tag: string };
  isMobile: boolean;
  showAddTaskModal: boolean;
  defaultColumnIdForNewTask: string | undefined;
  editTaskId: string | null;
  onAddTask: (columnId?: string, title?: string, description?: string, published?: boolean, boardId?: string, priority?: string) => void;
  onUpdateTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMoveToColumn: (taskId: string, toColumnId: string) => void;
  onAddComment: (taskId: string, content: string, author: string) => void;
  onTaskSelect: (taskId: string, task: Task, e?: React.MouseEvent) => void;
  onSelectAllTasks: (columnId: string, taskIds: string[]) => void;
  onLoadMoreTasks: (columnId: string) => void;
  onColumnRename: (columnId: string, newName: string) => void;
  onSetSelectedTask: (task: Task | null) => void;
  onSetActiveTask: (task: Task | null) => void;
  onSetShowAddTaskModal: (show: boolean) => void;
  onSetDefaultColumnIdForNewTask: (columnId: string | undefined) => void;
  onSetEditTaskId: (taskId: string | null) => void;
  getFilteredColumns: () => ColumnType[];
  updateTaskPosition: (activeId: string, overId: string, activeColumn: ColumnType, overColumn: ColumnType, activeTask: Task | null) => Promise<void>;
}

export function ColumnBoard({
  columns,
  currentBoard,
  boards,
  boardIdFromUrl,
  activeTask,
  selectedTask,
  selectedTasks,
  columnPagination,
  filters,
  isMobile,
  showAddTaskModal,
  defaultColumnIdForNewTask,
  editTaskId,
  onAddTask,
  onUpdateTask,
  onDeleteTask,
  onArchiveTask,
  onMoveToColumn,
  onAddComment,
  onTaskSelect,
  onSelectAllTasks,
  onLoadMoreTasks,
  onColumnRename,
  onSetSelectedTask,
  onSetActiveTask,
  onSetShowAddTaskModal,
  onSetDefaultColumnIdForNewTask,
  onSetEditTaskId,
  getFilteredColumns,
  updateTaskPosition,
}: ColumnBoardProps) {
  const { t } = useTranslation();
  const [activeMobileColumn, setActiveMobileColumn] = useState(0);
  const [mobileViewMode, setMobileViewMode] = useState<'tabs' | 'scroll'>('tabs');
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);
  const isDraggingRef = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: isMobile ? 16 : 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    if (!isMobile) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (isDraggingRef.current) return;
      touchStartX.current = e.touches[0].clientX;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isDraggingRef.current) return;
      touchEndX.current = e.touches[0].clientX;
    };

    const handleTouchEnd = () => {
      if (isDraggingRef.current) return;
      const deltaX = touchEndX.current - touchStartX.current;
      const minSwipeDistance = 50;

      if (mobileViewMode === 'tabs') {
        if (Math.abs(deltaX) > minSwipeDistance) {
          if (deltaX > 0 && activeMobileColumn > 0) {
            setActiveMobileColumn((prev) => prev - 1);
          } else if (deltaX < 0 && activeMobileColumn < columns.length - 1) {
            setActiveMobileColumn((prev) => prev + 1);
          }
        }
      } else {
        const scrollContainer = document.getElementById('mobile-scroll-container');
        if (scrollContainer && Math.abs(deltaX) > minSwipeDistance) {
          if (deltaX > 0) {
            scrollContainer.scrollLeft -= 100;
          } else {
            scrollContainer.scrollLeft += 100;
          }
        }
      }
      touchStartX.current = 0;
      touchEndX.current = 0;
    };

    const tabsContainer = document.getElementById('mobile-column-container');
    const scrollContainer = document.getElementById('mobile-scroll-container');

    if (mobileViewMode === 'tabs' && tabsContainer) {
      tabsContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
      tabsContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
      tabsContainer.addEventListener('touchend', handleTouchEnd, { passive: true });
    }

    if (mobileViewMode === 'scroll' && scrollContainer) {
      scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
      scrollContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
      scrollContainer.addEventListener('touchend', handleTouchEnd, { passive: true });
    }

    return () => {
      if (tabsContainer) {
        tabsContainer.removeEventListener('touchstart', handleTouchStart);
        tabsContainer.removeEventListener('touchmove', handleTouchMove);
        tabsContainer.removeEventListener('touchend', handleTouchEnd);
      }
      if (scrollContainer) {
        scrollContainer.removeEventListener('touchstart', handleTouchStart);
        scrollContainer.removeEventListener('touchmove', handleTouchMove);
        scrollContainer.removeEventListener('touchend', handleTouchEnd);
      }
    };
  }, [isMobile, activeMobileColumn, columns.length, mobileViewMode]);

  useEffect(() => {
    const scrollContainer = document.getElementById('columns-scroll-container');
    const fadeLeft = document.getElementById('scroll-fade-left');
    const fadeRight = document.getElementById('scroll-fade-right');
    const scrollHint = document.getElementById('scroll-hint');

    if (!scrollContainer || !fadeLeft || !fadeRight || !scrollHint) return;

    const updateScrollIndicators = () => {
      const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
      const hasOverflow = scrollWidth > clientWidth;
      const isAtStart = scrollLeft === 0;
      const isAtEnd = scrollLeft >= scrollWidth - clientWidth - 1;

      fadeLeft.style.opacity = (!isMobile && hasOverflow && !isAtStart) ? '1' : '0';
      fadeRight.style.opacity = (!isMobile && hasOverflow && !isAtEnd) ? '1' : '0';
      scrollHint.style.opacity = (!isMobile && hasOverflow && (isAtStart || isAtEnd)) ? '1' : '0';
    };

    scrollContainer.addEventListener('scroll', updateScrollIndicators);
    updateScrollIndicators();

    const resizeObserver = new ResizeObserver(updateScrollIndicators);
    resizeObserver.observe(scrollContainer);

    return () => {
      scrollContainer.removeEventListener('scroll', updateScrollIndicators);
      resizeObserver.disconnect();
    };
  }, [isMobile, columns.length]);

  const handleDragStart = (event: DragStartEvent) => {
    isDraggingRef.current = true;
    const { active } = event;
    const task = columns.flatMap((col) => col.tasks).find((t) => t.id === active.id);
    if (task) onSetActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    isDraggingRef.current = false;
    const { active, over } = event;

    if (!over) {
      onSetActiveTask(null);
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeColumn = columns.find((col) => col.tasks?.some((t) => t.id === activeId));
    const overColumn = columns.find(
      (col) => col.id === overId || col.tasks?.some((t) => t.id === overId)
    );

    if (!activeColumn || !overColumn) {
      onSetActiveTask(null);
      return;
    }

    await updateTaskPosition(activeId, overId, activeColumn, overColumn, activeTask);
    onSetActiveTask(null);
  };

  const filteredColumns = getFilteredColumns();

  return (
    <div className="bg-zinc-100 dark:bg-zinc-900">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {isMobile ? (
          <div className="flex flex-col h-[calc(100vh-120px)]">
            <div className="flex items-center justify-between gap-2 p-2 border-b border-zinc-200 dark:border-zinc-700">
              <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory flex-1">
                {filteredColumns.filter(Boolean).map((column, idx) => (
                  <button
                    key={column.id}
                    onClick={() => setActiveMobileColumn(idx)}
                    className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors snap-center ${
                      activeMobileColumn === idx
                        ? 'bg-blue-500 text-white'
                        : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'
                    }`}
                  >
                    {column.name}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setMobileViewMode(mobileViewMode === 'tabs' ? 'scroll' : 'tabs')}
                className="flex-shrink-0 p-2 rounded-lg bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300"
                title={mobileViewMode === 'tabs' ? t('mobile.switchToSlideView') : t('mobile.switchToListView')}
              >
                {mobileViewMode === 'tabs' ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7"/>
                    <rect x="14" y="3" width="7" height="7"/>
                    <rect x="14" y="14" width="7" height="7"/>
                    <rect x="3" y="14" width="7" height="7"/>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="3" y1="9" x2="21" y2="9"/>
                    <line x1="3" y1="15" x2="21" y2="15"/>
                  </svg>
                )}
              </button>
            </div>
            {mobileViewMode === 'tabs' ? (
              <div id="mobile-column-container" className="flex-1 overflow-y-auto p-2">
                {filteredColumns.filter(Boolean)[activeMobileColumn] && (
                  <Column
                    column={filteredColumns.filter(Boolean)[activeMobileColumn]}
                    currentBoardId={currentBoard?.id}
                    boards={boards}
                    isMobileView={true}
                    onAddTask={(colId, title, desc, pub) => onAddTask(colId, title, desc, pub)}
                    onTaskClick={onSetSelectedTask}
                    onTaskCommentsClick={onSetSelectedTask}
                    onTaskArchive={onArchiveTask}
                    onTaskDelete={onDeleteTask}
                    onTaskMoveToColumn={onMoveToColumn}
                    allColumns={columns.map(c => ({ id: c.id, name: c.name }))}
                    onOpenAddTask={(columnId) => {
                      onSetDefaultColumnIdForNewTask(columnId);
                      onSetShowAddTaskModal(true);
                    }}
                    onColumnRename={onColumnRename}
                    searchQuery={filters.searchQuery}
                    selectedTasks={selectedTasks}
                    onSelectTask={onTaskSelect}
                    onSelectAllTasks={onSelectAllTasks}
                    onLoadMore={onLoadMoreTasks}
                    hasMore={columnPagination[filteredColumns.filter(Boolean)[activeMobileColumn]?.id]?.hasMore}
                    isLoadingMore={columnPagination[filteredColumns.filter(Boolean)[activeMobileColumn]?.id]?.isLoadingMore}
                  />
                )}
              </div>
            ) : (
              <div id="mobile-scroll-container" className="relative flex-1 min-h-0 overflow-x-auto overflow-y-hidden pb-4">
                <div className="flex gap-3 p-2 h-full min-h-0">
                  {filteredColumns.filter(Boolean).map((column) => (
                    <Column
                      key={column.id}
                      column={column}
                      currentBoardId={currentBoard?.id}
                      boards={boards}
                      isMobileView={true}
                      onAddTask={(colId, title, desc, pub) => onAddTask(colId, title, desc, pub)}
                      onTaskClick={onSetSelectedTask}
                      onTaskCommentsClick={onSetSelectedTask}
                      onTaskArchive={onArchiveTask}
                      onTaskDelete={onDeleteTask}
                      onTaskMoveToColumn={onMoveToColumn}
                      allColumns={columns.map(c => ({ id: c.id, name: c.name }))}
                      onOpenAddTask={(columnId) => {
                        onSetDefaultColumnIdForNewTask(columnId);
                        onSetShowAddTaskModal(true);
                      }}
                      onColumnRename={onColumnRename}
                      searchQuery={filters.searchQuery}
                      selectedTasks={selectedTasks}
                      onSelectTask={onTaskSelect}
                      onSelectAllTasks={onSelectAllTasks}
                      onLoadMore={onLoadMoreTasks}
                      hasMore={columnPagination[column.id]?.hasMore}
                      isLoadingMore={columnPagination[column.id]?.isLoadingMore}
                    />
                  ))}
                </div>
                <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-zinc-100/80 to-transparent dark:from-zinc-900/80 pointer-events-none" />
                <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-zinc-100/80 to-transparent dark:from-zinc-900/80 pointer-events-none" />
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-zinc-800/70 text-white text-xs px-2 py-1 rounded-full dark:bg-zinc-200/70 dark:text-zinc-800">
                  {t('mobile.columnsCount', { count: columns.length })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="relative h-[calc(100vh-120px)] overflow-hidden p-6">
            <div className="flex gap-4 overflow-x-auto pb-4 flex-nowrap h-full" id="columns-scroll-container">
              {filteredColumns.filter(Boolean).map((column) => (
                <Column
                  key={column.id}
                  column={column}
                  currentBoardId={currentBoard?.id}
                  boards={boards}
                  onAddTask={(colId, title, desc, pub) => onAddTask(colId, title, desc, pub)}
                  onTaskClick={onSetSelectedTask}
                  onTaskCommentsClick={onSetSelectedTask}
                  onTaskArchive={onArchiveTask}
                  onTaskDelete={onDeleteTask}
                  onTaskMoveToColumn={onMoveToColumn}
                  allColumns={columns.map(c => ({ id: c.id, name: c.name }))}
                  onOpenAddTask={(columnId) => {
                    onSetDefaultColumnIdForNewTask(columnId);
                    onSetShowAddTaskModal(true);
                  }}
                  onColumnRename={onColumnRename}
                  searchQuery={filters.searchQuery}
                  selectedTasks={selectedTasks}
                  onSelectTask={onTaskSelect}
                  onSelectAllTasks={onSelectAllTasks}
                  onLoadMore={onLoadMoreTasks}
                  hasMore={columnPagination[column.id]?.hasMore}
                  isLoadingMore={columnPagination[column.id]?.isLoadingMore}
                />
              ))}
            </div>
            <div className="absolute left-0 top-0 bottom-4 w-8 bg-gradient-to-r from-zinc-100 dark:from-zinc-900 to-transparent pointer-events-none z-10" id="scroll-fade-left" />
            <div className="absolute right-4 top-0 bottom-4 w-8 bg-gradient-to-l from-zinc-100 dark:from-zinc-900 to-transparent pointer-events-none z-10" id="scroll-fade-right" />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 bg-zinc-800/70 text-white text-xs px-2 py-1 rounded-full dark:bg-zinc-200/70 dark:text-zinc-800 opacity-0 transition-opacity" id="scroll-hint">
              {t('board.scrollHint')}
            </div>
          </div>
        )}

        <AddTaskModal
          isOpen={showAddTaskModal}
          defaultColumnId={defaultColumnIdForNewTask}
          currentBoardId={currentBoard?.id}
          boards={boards}
          onClose={() => {
            onSetShowAddTaskModal(false);
            onSetDefaultColumnIdForNewTask(undefined);
          }}
          onSubmit={(title, description, published, columnId, boardId, priority) => {
            onAddTask(columnId, title, description, published, boardId, priority);
            onSetShowAddTaskModal(false);
            onSetDefaultColumnIdForNewTask(undefined);
          }}
        />

        <DragLayer activeTask={activeTask} />
      </DndContext>

      {selectedTask && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }>
          <TaskModal
            task={selectedTask}
            columnName={columns.find((col) => col.tasks.some((t) => t.id === selectedTask.id))?.name}
            columns={columns.map((c) => ({ id: c.id, name: c.name }))}
            boardId={boardIdFromUrl}
            boards={boards}
            canEdit={true}
            startEditing={editTaskId === selectedTask.id}
            onClose={() => { onSetSelectedTask(null); onSetEditTaskId(null); }}
            onUpdate={onUpdateTask}
            onDelete={onDeleteTask}
            onArchive={onArchiveTask}
            onAddComment={onAddComment}
            onEditingStarted={() => onSetEditTaskId(null)}
          />
        </Suspense>
      )}
    </div>
  );
}