import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface WsWarningProps {
  wsStatus: 'connected' | 'disconnected' | 'failed';
  reconnectCount: number;
  onConnectWebSocket: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;

interface OriginCheck {
  allowed: boolean;
  hint: string;
}

async function fetchOriginHint(): Promise<OriginCheck | null> {
  try {
    const res = await fetch('/api/v1/origins/check', { credentials: 'omit' });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<OriginCheck>;
    if (typeof data.allowed !== 'boolean') return null;
    return { allowed: data.allowed, hint: data.hint || '' };
  } catch {
    return null;
  }
}

export function WsWarning({ wsStatus, reconnectCount, onConnectWebSocket }: WsWarningProps) {
  const { t } = useTranslation();
  const [originHint, setOriginHint] = useState<string>('');

  // s-1260 / PM review s-1258 P2-11: ping /api/v1/origins/check
  // when the socket enters a non-connected state so the toast can
  // tell the user *why* the handshake failed (most commonly:
  // ALLOWED_ORIGINS not matching the dev port).
  useEffect(() => {
    if (wsStatus === 'connected') {
      setOriginHint('');
      return;
    }
    let cancelled = false;
    void fetchOriginHint().then((check) => {
      if (cancelled || !check || check.allowed) return;
      setOriginHint(check.hint);
    });
    return () => {
      cancelled = true;
    };
  }, [wsStatus]);

  if (wsStatus === 'connected') return null;

  return (
    <div
      style={{ position: 'fixed', bottom: '1rem', left: '1rem', zIndex: 9, minWidth: 300, maxWidth: 480, width: 'auto' }}
      className="rounded-lg bg-orange-100 border border-orange-300 px-4 py-3 flex flex-col gap-2"
      role="status"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-orange-600"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-sm font-medium text-orange-800">
            {wsStatus === 'failed' ? t('wsStatus.connectionFailed') : t('wsStatus.connectionLost')}
          </span>
          {reconnectCount > 0 && (
            <span className="text-xs text-orange-600">
              ({t('wsStatus.reconnecting', { attempt: reconnectCount, max: MAX_RECONNECT_ATTEMPTS })})
            </span>
          )}
        </div>
        <button
          onClick={onConnectWebSocket}
          className="text-xs text-orange-600 hover:text-orange-800 font-medium"
        >
          {t('wsStatus.retryNow')}
        </button>
      </div>
      {originHint && (
        <pre className="whitespace-pre-wrap break-words text-xs text-orange-700 border-t border-orange-200 pt-2">
          {originHint}
        </pre>
      )}
    </div>
  );
}