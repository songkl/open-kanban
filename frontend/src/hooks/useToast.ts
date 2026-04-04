import { useState, useCallback } from 'react';

export function useToast(duration = 2000) {
  const [toast, setToast] = useState<string | null>(null);

  const showToastMessage = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), duration);
  }, [duration]);

  return { toast, showToastMessage };
}
