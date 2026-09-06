import { useState, useEffect, useRef, useCallback } from 'react';
import type { Board } from '../types/kanban';

const REFRESH_DEBOUNCE_MS = 1000;

// scheduleBoardUpdate defers a state-merge callback by one animation
// frame. The WebSocket refresh path is the trigger of the s-1051
// `reportAllChanges` crash: when the dev server (or the React DevTools
// browser extension) is recording a perf measurement, the same tick
// that receives a `refresh` message replaces the column container mid-
// measurement, and the perf observer then reads an entry whose
// `startTime` was never set. Scheduling the merge for the next frame
// keeps the React commit aligned with the browser's paint cadence so
// the perf observer always sees a settled tree.
//
// In production the dev / extension profiler is not active, so the
// deferral is harmless — it adds at most ~16 ms to a refresh that
// already triggers a full column re-render.
const scheduleBoardUpdate = (fn: () => void) => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    fn();
    return;
  }
  window.requestAnimationFrame(() => fn());
};

interface UseBoardWebSocketOptions {
  currentBoard: Board | null;
  fetchColumns: (boardId: string, silent?: boolean) => Promise<void>;
  handleTaskNotificationUpdate: (taskId: string) => Promise<void>;
  processOfflineQueue: () => Promise<void>;
  lastLocalUpdateRef: React.MutableRefObject<number>;
}

interface UseBoardWebSocketReturn {
  wsStatus: 'connected' | 'disconnected' | 'failed';
  reconnectCount: number;
  connectWebSocket: () => void;
}

export function useBoardWebSocket({
  currentBoard,
  fetchColumns,
  handleTaskNotificationUpdate,
  processOfflineQueue,
  lastLocalUpdateRef,
}: UseBoardWebSocketOptions): UseBoardWebSocketReturn {
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'failed'>('disconnected');
  const [reconnectCount, setReconnectCount] = useState(0);
  const reconnectAttemptRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const currentBoardRef = useRef<Board | null>(null);
  const connectWebSocketRef = useRef<(() => void) | null>(null);
  const unmountedRef = useRef(false);
  const connectionIdRef = useRef(0);
  const callbacksRef = useRef({ fetchColumns, handleTaskNotificationUpdate, processOfflineQueue, lastLocalUpdateRef });

  useEffect(() => {
    currentBoardRef.current = currentBoard;
  }, [currentBoard]);

  useEffect(() => {
    callbacksRef.current = { fetchColumns, handleTaskNotificationUpdate, processOfflineQueue, lastLocalUpdateRef };
  }, [fetchColumns, handleTaskNotificationUpdate, processOfflineQueue, lastLocalUpdateRef]);

  const connectWebSocket = useCallback(() => {
    if (unmountedRef.current) return;
    const currentConnectionId = ++connectionIdRef.current;
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    }
    const getWsUrl = () => {
      if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
      if (import.meta.env.DEV) {
        return `ws://localhost:8081/ws`;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}/ws`;
    };
    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);
    const MAX_RECONNECT_ATTEMPTS = 5;
    const MAX_RECONNECT_DELAY = 30000;

    const getReconnectDelay = (attempt: number) => {
      const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
      return delay + Math.random() * 1000;
    };

    ws.onerror = () => {
      if (unmountedRef.current || currentConnectionId !== connectionIdRef.current) return;
      console.log('WebSocket error occurred');
    };

    ws.onopen = () => {
      if (unmountedRef.current) return;
      console.log('WebSocket connected');
      setWsStatus('connected');
      setReconnectCount(0);
      reconnectAttemptRef.current = 0;
      callbacksRef.current.processOfflineQueue();
      if (currentBoardRef.current) {
        const boardId = currentBoardRef.current.id;
        scheduleBoardUpdate(() => callbacksRef.current.fetchColumns(boardId, true));
      }
    };

    const HEARTBEAT_INTERVAL = 15000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const sendHeartbeat = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    };

    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

    ws.onmessage = (event) => {
      if (unmountedRef.current) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'heartbeat_ack') {
          return;
        }
        if (message.type === 'refresh') {
          const now = Date.now();
          if (now - callbacksRef.current.lastLocalUpdateRef.current < REFRESH_DEBOUNCE_MS) {
            console.log('Skipping redundant refresh after local update');
            return;
          }
          if (currentBoardRef.current) {
            const boardId = currentBoardRef.current.id;
            scheduleBoardUpdate(() => callbacksRef.current.fetchColumns(boardId, true));
          }
        } else if (message.type === 'task_notification') {
          const { boardId, taskId, action } = message;
          if (currentBoardRef.current && boardId === currentBoardRef.current.id) {
            const now = Date.now();
            if (now - callbacksRef.current.lastLocalUpdateRef.current < REFRESH_DEBOUNCE_MS) {
              return;
            }
            if (action === 'create') {
              const fetchBoardId = currentBoardRef.current.id;
              scheduleBoardUpdate(() => callbacksRef.current.fetchColumns(fetchBoardId, true));
            } else if (action === 'update' || action === 'update_status') {
              callbacksRef.current.handleTaskNotificationUpdate(taskId);
            }
          }
        }
      } catch {
        console.error('Failed to parse WebSocket message');
      }
    };

    ws.onclose = () => {
      if (unmountedRef.current || currentConnectionId !== connectionIdRef.current) return;
      console.log('WebSocket disconnected');
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      const attempt = reconnectAttemptRef.current;
      if (attempt < MAX_RECONNECT_ATTEMPTS) {
        setWsStatus('disconnected');
        setReconnectCount(attempt + 1);
        const delay = getReconnectDelay(attempt);
        console.log(`Reconnecting in ${delay}ms (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`);
        reconnectAttemptRef.current = attempt + 1;
        setTimeout(() => connectWebSocketRef.current?.(), delay);
      } else {
        console.log('Max reconnect attempts reached');
        setWsStatus('failed');
      }
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  useEffect(() => {
    unmountedRef.current = false;
    connectWebSocket();

    return () => {
      unmountedRef.current = true;
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connectWebSocket]);

  return {
    wsStatus,
    reconnectCount,
    connectWebSocket,
  };
}