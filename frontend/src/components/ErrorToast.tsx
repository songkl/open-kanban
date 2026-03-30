import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface ErrorToast {
  id: string;
  message: string;
  type: 'error' | 'warning' | 'info';
}

let addErrorToast: ((message: string, type?: 'error' | 'warning' | 'info') => void) | null = null;

export function setErrorToastHandler(handler: typeof addErrorToast) {
  addErrorToast = handler;
}

export function showErrorToast(message: string, type: 'error' | 'warning' | 'info' = 'error') {
  if (addErrorToast) {
    addErrorToast(message, type);
  }
}

export function ErrorToastContainer() {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ErrorToast[]>([]);

  useEffect(() => {
    addErrorToast = (message: string, type: 'error' | 'warning' | 'info' = 'error') => {
      const id = Date.now().toString() + Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { id, message, type }]);

      // Auto remove after 5 seconds
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    };

    return () => {
      addErrorToast = null;
    };
  }, []);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const getTypeStyles = (type: string) => {
    switch (type) {
      case 'error':
        return 'bg-red-50 border-red-200 text-red-800';
      case 'warning':
        return 'bg-yellow-50 border-yellow-200 text-yellow-800';
      case 'info':
        return 'bg-blue-50 border-blue-200 text-blue-800';
      default:
        return 'bg-red-50 border-red-200 text-red-800';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'error':
        return (
          <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case 'warning':
        return (
          <svg className="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        );
      case 'info':
        return (
          <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      default:
        return null;
    }
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-start gap-3 min-w-[320px] max-w-md p-4 rounded-lg border shadow-lg animate-in slide-in-from-right fade-in duration-300 ${getTypeStyles(toast.type)}`}
          role="alert"
        >
          <div className="flex-shrink-0 mt-0.5">{getTypeIcon(toast.type)}</div>
          <div className="flex-1">
            <p className="text-sm font-medium">
              {toast.type === 'error' ? t('app.error.requestFailed') : toast.type === 'warning' ? t('app.error.warning') : t('app.error.info')}
            </p>
            <p className="text-sm mt-1 opacity-90">{toast.message}</p>
          </div>
          <button
            onClick={() => removeToast(toast.id)}
            className="flex-shrink-0 -mr-1 -mt-1 p-1 rounded hover:bg-black/5 transition-colors"
            aria-label={t('app.close')}
          >
            <svg className="w-4 h-4 opacity-50 hover:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
