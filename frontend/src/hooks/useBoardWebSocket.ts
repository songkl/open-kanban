import { useState, useEffect, useRef, useCallback } from 'react';
import type { Board } from '../types/kanban';

const REFRESH_DEBOUNCE_MS = 1000;

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

  useEffect(() => {
    currentBoardRef.current = currentBoard;
  }, [currentBoard]);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
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
      return delay;
    };

    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsStatus('connected');
      setReconnectCount(0);
      reconnectAttemptRef.current = 0;
      processOfflineQueue();
      if (currentBoardRef.current) {
        fetchColumns(currentBoardRef.current.id, true);
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
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'heartbeat_ack') {
          return;
        }
        if (message.type === 'refresh') {
          const now = Date.now();
          if (now - lastLocalUpdateRef.current < REFRESH_DEBOUNCE_MS) {
            console.log('Skipping redundant refresh after local update');
            return;
          }
          if (currentBoardRef.current) {
            fetchColumns(currentBoardRef.current.id, true);
          }
        } else if (message.type === 'task_notification') {
          const { boardId, taskId, action } = message;
          if (currentBoardRef.current && boardId === currentBoardRef.current.id) {
            const now = Date.now();
            if (now - lastLocalUpdateRef.current < REFRESH_DEBOUNCE_MS) {
              return;
            }
            if (action === 'create') {
              fetchColumns(currentBoardRef.current.id, true);
            } else if (action === 'update' || action === 'update_status') {
              handleTaskNotificationUpdate(taskId);
            }
          }
        }
      } catch {
        console.error('Failed to parse WebSocket message');
      }
    };

    ws.onclose = () => {
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

    ws.onerror = () => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.error('WebSocket error: connection failed');
      }
    };

    wsRef.current = ws;
  }, [fetchColumns, handleTaskNotificationUpdate, processOfflineQueue, lastLocalUpdateRef]);

  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  useEffect(() => {
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.CONNECTING) {
          wsRef.current.onclose = null;
        }
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