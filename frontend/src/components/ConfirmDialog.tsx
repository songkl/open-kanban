import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'danger' | 'warning' | 'default';
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  variant = 'default',
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onCancel();
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onCancel]);

  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const variantStyles = {
    danger: 'from-red-500 to-red-600 hover:from-red-600 hover:to-red-700',
    warning: 'from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600',
    default: 'from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div className="absolute inset-0" />
      <div
        ref={dialogRef}
        className="relative z-10 w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${variantStyles[variant].split(' ')[0]} ${variantStyles[variant].split(' ')[1]} text-white shadow-lg`}>
            {variant === 'danger' ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            )}
          </div>
          <h3 className="text-lg font-bold text-zinc-800">
            {title}
          </h3>
        </div>
        <p className="mb-6 text-sm text-zinc-600">
          {message}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
          >
            {cancelText || t('task.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 rounded-xl bg-gradient-to-r ${variantStyles[variant]} px-4 py-3 font-medium text-white transition-all shadow-sm hover:shadow`}
          >
            {confirmText || t('task.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}