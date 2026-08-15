import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '@/services/api';

export function useSetupGuard(): void {
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((data) => {
        if (!cancelled && data.needsSetup) {
          navigate('/setup', { replace: true });
        }
      })
      .catch(() => {
        /* ignore: page can still attempt to load */
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);
}