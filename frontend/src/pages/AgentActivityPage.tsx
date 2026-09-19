import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, activitiesApi } from '../services/api';
import { LoadingScreen } from '../components/LoadingScreen';
import { UserAvatar } from '../components/UserAvatar';
import type { Agent } from '../types/kanban';
import { useSetupGuard } from '../hooks/useSetupGuard';

interface Activity {
  id: string;
  userId: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetTitle?: string;
  details?: string;
  ipAddress?: string;
  source?: string;
  createdAt: string;
}

// Agent health thresholds (s-1209, PM_REVIEW_2026-09-17 §3.9).
// Kept as module-level constants so the same numbers drive the
// sidebar badge and the detail panel — and so future PM tweaks
// land in one place.
const HEALTH_HEARTBEAT_WARNING_MS = 10 * 60 * 1000;
const HEALTH_HEARTBEAT_UNHEALTHY_MS = 60 * 60 * 1000;
const HEALTH_MIN_RUNS_FOR_FAILURE_RATE = 3;
const HEALTH_FAILURE_RATE_UNHEALTHY = 0.25;

export type AgentHealth = 'healthy' | 'warning' | 'unhealthy';

export function getAgentHealth(agent: Agent): AgentHealth {
  const runsLast24h = agent.runsLast24h ?? 0;
  const failsLast24h = agent.failsLast24h ?? 0;
  const heartbeatRaw = agent.lastHeartbeatAt ?? agent.lastActiveAt;
  if (!heartbeatRaw) {
    return 'unhealthy';
  }
  const heartbeat = new Date(heartbeatRaw).getTime();
  if (Number.isNaN(heartbeat)) {
    return 'unhealthy';
  }
  const sinceMs = Date.now() - heartbeat;
  if (sinceMs >= HEALTH_HEARTBEAT_UNHEALTHY_MS) {
    return 'unhealthy';
  }
  if (
    runsLast24h >= HEALTH_MIN_RUNS_FOR_FAILURE_RATE &&
    failsLast24h / runsLast24h >= HEALTH_FAILURE_RATE_UNHEALTHY
  ) {
    return 'unhealthy';
  }
  if (sinceMs >= HEALTH_HEARTBEAT_WARNING_MS) {
    return 'warning';
  }
  if (failsLast24h > 0) {
    return 'warning';
  }
  return 'healthy';
}

export function getAgentFailureRate(agent: Agent): number {
  const runs = agent.runsLast24h ?? 0;
  if (runs <= 0) return 0;
  return (agent.failsLast24h ?? 0) / runs;
}

type AgentSortKey = 'lastActive' | 'failureRate' | 'totalRuns' | 'name';

function healthBadgeDotClass(health: AgentHealth): string {
  switch (health) {
    case 'healthy':
      return 'bg-green-500';
    case 'warning':
      return 'bg-yellow-500';
    case 'unhealthy':
      return 'bg-red-500';
  }
}

function healthPanelClass(health: AgentHealth): string {
  switch (health) {
    case 'healthy':
      return 'border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/30';
    case 'warning':
      return 'border-yellow-200 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-900/30';
    case 'unhealthy':
      return 'border-red-200 bg-red-50 dark:border-red-700 dark:bg-red-900/30';
  }
}

function failureRateColor(rate: number): string {
  if (rate >= HEALTH_FAILURE_RATE_UNHEALTHY) return 'text-red-600 dark:text-red-400';
  if (rate > 0) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-zinc-500 dark:text-zinc-500';
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value * 100)}%`;
}

function formatHeartbeatRelative(lastHeartbeatAt: string | null | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!lastHeartbeatAt) return t('settings.neverActive');
  const date = new Date(lastHeartbeatAt);
  if (Number.isNaN(date.getTime())) return t('settings.neverActive');
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('taskModal.justNow');
  if (diffMins < 60) return t('taskModal.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('taskModal.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('taskModal.daysAgo', { count: diffDays });
  return date.toLocaleString();
}

const actionIcons: Record<string, string> = {
  CREATE_TASK: '📝',
  COMPLETE_TASK: '✅',
  ADD_COMMENT: '💬',
  UPDATE_TASK: '✏️',
  DELETE_TASK: '🗑️',
  BOARD_CREATE: '📋',
  BOARD_UPDATE: '📋',
  BOARD_DELETE: '📋',
  COLUMN_CREATE: '📑',
  COLUMN_UPDATE: '📑',
  COLUMN_DELETE: '📑',
  USER_CREATE: '👤',
  USER_UPDATE: '👤',
  LOGIN: '🔑',
  LOGOUT: '🔒',
  BOARD_COPY: '📋',
  TEMPLATE_CREATE: '📝',
  TEMPLATE_DELETE: '🗑️',
  BOARD_IMPORT: '📥',
};

export function AgentActivityPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useSetupGuard();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [agentSearchQuery, setAgentSearchQuery] = useState('');
  const [agentSortKey, setAgentSortKey] = useState<AgentSortKey>('lastActive');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);

  const loadActivities = useCallback(async (agentId?: string, offset = 0) => {
    try {
      const data = await activitiesApi.getByAgent(agentId, offset, 50);
      const newActivities = data.activities || [];
      if (offset === 0) {
        setActivities(newActivities);
      } else {
        setActivities((prev) => [...prev, ...newActivities]);
      }
      setHasMore(data.hasMore ?? false);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.error('Failed to load activities:', err);
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [agentsData, meData] = await Promise.all([
        authApi.getAgents(),
        authApi.me(),
      ]);
      if (!meData.user) {
        return;
      }
      setAgents(agentsData || []);
      await loadActivities();
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  }, [loadActivities]);

  const syncActivities = useCallback(async (agentId?: string) => {
    try {
      const data = await activitiesApi.getByAgent(agentId, 0, 50);
      const fetched = data.activities || [];
      setActivities((prev) => {
        const existingIds = new Set(prev.map((a) => a.id));
        const newItems = fetched.filter((a: Activity) => !existingIds.has(a.id));
        if (newItems.length === 0) return prev;
        return [...newItems, ...prev];
      });
    } catch (err) {
      console.error('Failed to sync activities:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const MAX_RECONNECT_ATTEMPTS = 10;
    const MAX_RECONNECT_DELAY = 30000;

    const getReconnectDelay = (attempt: number) => {
      const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
      return delay;
    };

    const connectWebSocket = () => {
      const getWsUrl = () => {
        if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
        if (import.meta.env.DEV) {
          return `ws://localhost:8081/ws`;
        }
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws`;
      };
      if (wsRef.current) {
        wsRef.current.onclose = null;
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
          wsRef.current.close();
        }
      }
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
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
          if (message.type === 'new_activity') {
            const newActivity: Activity = message.activity;
            setActivities((prev) => {
              if (prev.some((a) => a.id === newActivity.id)) return prev;
              const filtered = selectedAgentId
                ? prev.filter((a) => a.userId === selectedAgentId)
                : prev;
              return [newActivity, ...filtered];
            });
            authApi.getAgents().then((agentsData) => {
              setAgents(agentsData || []);
            });
          }
          } catch {
            // Ignore parse errors for non-JSON messages
          }
      };

      ws.onerror = () => {};

      ws.onclose = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const attempt = reconnectAttemptRef.current;
        if (attempt < MAX_RECONNECT_ATTEMPTS) {
          const delay = getReconnectDelay(attempt);
          console.log(`WebSocket reconnecting in ${delay}ms (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`);
          reconnectAttemptRef.current = attempt + 1;
          setTimeout(connectWebSocket, delay);
        } else {
          console.log('WebSocket max reconnect attempts reached');
        }
      };
    };

    connectWebSocket();
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [selectedAgentId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      syncActivities(selectedAgentId || undefined);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, selectedAgentId, syncActivities]);

  useEffect(() => {
    if (isAtBottom && logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [activities, isAtBottom]);

  const loadMore = async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const nextOffset = activities.length;
      await loadActivities(selectedAgentId || undefined, nextOffset);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleAgentSelect = (agentId: string) => {
    const newSelectedId = selectedAgentId === agentId ? '' : agentId;
    setSelectedAgentId(newSelectedId);
    loadActivities(newSelectedId || undefined);
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('taskModal.justNow');
    if (diffMins < 60) return t('taskModal.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('taskModal.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('taskModal.daysAgo', { count: diffDays });
    return date.toLocaleString();
  };

  const formatLastActive = (lastActiveAt?: string) => {
    if (!lastActiveAt) return t('settings.neverActive');
    const date = new Date(lastActiveAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('taskModal.justNow');
    if (diffMins < 60) return t('taskModal.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('taskModal.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('taskModal.daysAgo', { count: diffDays });
    return date.toLocaleString();
  };

  const sortedAgents = [...agents].sort((a, b) => {
    switch (agentSortKey) {
      case 'failureRate': {
        const rateDelta = getAgentFailureRate(b) - getAgentFailureRate(a);
        if (rateDelta !== 0) return rateDelta;
        return (b.runsLast24h ?? 0) - (a.runsLast24h ?? 0);
      }
      case 'totalRuns':
        return (b.totalRuns ?? 0) - (a.totalRuns ?? 0);
      case 'name':
        return a.nickname.localeCompare(b.nickname);
      case 'lastActive':
      default: {
        const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
        const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
        return bTime - aTime;
      }
    }
  });

  const filteredAgents = agentSearchQuery
    ? sortedAgents.filter((agent) =>
        agent.nickname.toLowerCase().includes(agentSearchQuery.toLowerCase())
      )
    : sortedAgents;

  const handleScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    setIsAtBottom(scrollTop + clientHeight >= scrollHeight - 50);
    if (scrollTop + clientHeight >= scrollHeight - 200) {
      loadMore();
    }
  };

  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-900">
      <div className="flex h-screen">
        <div className="w-80 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
          <div className="flex h-full flex-col">
            <div className="border-b border-zinc-200 dark:border-zinc-700 p-4">
              <Link
                to="/"
                className="mb-4 inline-block rounded-md bg-zinc-200 dark:bg-zinc-700 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600"
              >
                ← {t('nav.back')}
              </Link>
              <h1 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">{t('nav.agentActivity')}</h1>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                {t('settings.agentActivity.description')}
              </p>
            </div>

            <div className="border-b border-zinc-200 dark:border-zinc-700 p-3">
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                {t('settings.agentActivity.filterByAgent')}
              </label>
              <input
                type="text"
                value={agentSearchQuery}
                onChange={(e) => setAgentSearchQuery(e.target.value)}
                placeholder={t('filter.search')}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="border-b border-zinc-200 dark:border-zinc-700 p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="agentSortKey"
                  className="block text-xs font-medium text-zinc-600 dark:text-zinc-300"
                >
                  {t('settings.agentActivity.sortBy')}
                </label>
              </div>
              <select
                id="agentSortKey"
                value={agentSortKey}
                onChange={(e) => setAgentSortKey(e.target.value as AgentSortKey)}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                data-testid="agent-sort-key"
              >
                <option value="lastActive">{t('settings.agentActivity.sortLastActive')}</option>
                <option value="failureRate">{t('settings.agentActivity.sortFailureRate')}</option>
                <option value="totalRuns">{t('settings.agentActivity.sortTotalRuns')}</option>
                <option value="name">{t('settings.agentActivity.sortName')}</option>
              </select>
              <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                <span>{t('settings.agentActivity.healthBadge')}</span>
                <span className="text-right">{t('settings.agentActivity.failureRate24h')}</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              <h2 className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-500 uppercase tracking-wide">
                {t('settings.agentActivity.recentlyActive')}
              </h2>
              <div className="space-y-2">
                {filteredAgents.length === 0 ? (
                  <div className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-500">
                    {agentSearchQuery ? t('filter.noResults') : t('settings.noAgents')}
                  </div>
                ) : (
                  filteredAgents.map((agent) => {
                    const health = getAgentHealth(agent);
                    const failureRate = getAgentFailureRate(agent);
                    return (
                      <button
                        key={agent.id}
                        onClick={() => handleAgentSelect(agent.id)}
                        className={`w-full flex items-center gap-3 rounded-lg p-2 text-left transition-colors ${
                          selectedAgentId === agent.id
                            ? 'bg-blue-100 ring-1 ring-blue-300'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-600 dark:bg-zinc-700 dark:hover:bg-zinc-700'
                        }`}
                        data-testid={`agent-list-item-${agent.id}`}
                      >
                        <div className="relative">
                          <UserAvatar
                            username={agent.nickname}
                            avatar={agent.avatar}
                            size="sm"
                          />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${healthBadgeDotClass(health)}`}
                            aria-label={t(`settings.agentActivity.health.${health}`)}
                            title={t(`settings.agentActivity.health.${health}`)}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-zinc-800 dark:text-zinc-100 truncate">{agent.nickname}</div>
                          <div className="text-xs text-zinc-400 dark:text-zinc-500">
                            {formatLastActive(agent.lastActiveAt)}
                          </div>
                        </div>
                        <div className="flex flex-col items-end text-[10px] text-zinc-500 dark:text-zinc-500">
                          <span className={`font-medium ${failureRateColor(failureRate)}`}>
                            {formatPercent(failureRate)}
                          </span>
                          <span>
                            {agent.runsLast24h ?? 0} / {agent.failsLast24h ?? 0}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          <div className="border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-6 py-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
                {selectedAgentId
                  ? `${agents.find((a) => a.id === selectedAgentId)?.nickname || ''} ${t('settings.agentActivity.activityLog')}`
                  : t('settings.agentActivity.allActivityLog')}
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-500">
                {total > 0
                  ? `${t('settings.agentActivity.recordCountWithTotal', { count: activities.length, total })} ${t('nav.records')}`
                  : `${t('settings.agentActivity.recordCount', { count: activities.length })} ${t('nav.records')}`}
                {autoRefresh && ` ${t('settings.agentActivity.separator')} ${t('settings.agentActivity.autoRefreshOn')}`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="rounded border-zinc-300 dark:border-zinc-600"
                />
                {t('settings.agentActivity.autoRefresh')}
              </label>
              <button
                onClick={() => loadActivities(selectedAgentId || undefined)}
                className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
              >
                {t('settings.agentActivity.refresh')}
              </button>
            </div>
          </div>

          {selectedAgentId && (() => {
            const selectedAgent = agents.find((a) => a.id === selectedAgentId);
            if (!selectedAgent) return null;
            const health = getAgentHealth(selectedAgent);
            const failureRate = getAgentFailureRate(selectedAgent);
            return (
              <div
                className={`m-4 rounded-lg border p-4 ${healthPanelClass(health)}`}
                data-testid="agent-health-panel"
              >
                <div className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full ${healthBadgeDotClass(health)}`} aria-hidden="true" />
                  <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                    {t('settings.agentActivity.healthPanelTitle')}
                  </span>
                  <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {t(`settings.agentActivity.health.${health}`)}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                      {t('settings.agentActivity.lastHeartbeatAt')}
                    </dt>
                    <dd className="font-medium text-zinc-800 dark:text-zinc-100">
                      {formatHeartbeatRelative(selectedAgent.lastHeartbeatAt ?? selectedAgent.lastActiveAt, t)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                      {t('settings.agentActivity.runsLast24h')}
                    </dt>
                    <dd className="font-medium text-zinc-800 dark:text-zinc-100">
                      {selectedAgent.runsLast24h ?? 0}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                      {t('settings.agentActivity.failsLast24h')}
                    </dt>
                    <dd className={`font-medium ${failureRate > 0 ? failureRateColor(failureRate) : 'text-zinc-800 dark:text-zinc-100'}`}>
                      {selectedAgent.failsLast24h ?? 0}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                      {t('settings.agentActivity.failureRate24h')}
                    </dt>
                    <dd className={`font-medium ${failureRateColor(failureRate)}`}>
                      {formatPercent(failureRate)}
                    </dd>
                  </div>
                  <div className="col-span-2 sm:col-span-4">
                    <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                      {t('settings.agentActivity.totalRuns')}
                    </dt>
                    <dd className="font-medium text-zinc-800 dark:text-zinc-100">
                      {selectedAgent.totalRuns ?? 0}
                    </dd>
                  </div>
                </dl>
              </div>
            );
          })()}

          <div
            ref={logContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto p-6"
          >
            {activities.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center text-zinc-500 dark:text-zinc-500">
                  <div className="mb-2 text-4xl">🤖</div>
                  <div>{t('settings.noActivities')}</div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {activities.map((activity) => {
                  const agent = agents.find((a) => a.id === activity.userId);
                  return (
                    <div
                      key={activity.id}
                      className="flex items-start gap-4 rounded-lg bg-white dark:bg-zinc-800 p-4 shadow"
                    >
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-blue-100">
                        <span className="text-lg">{actionIcons[activity.action] || '📌'}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-zinc-800 dark:text-zinc-100">
                            {typeof t(`settings.activities.${activity.action}`) === 'string' ? t(`settings.activities.${activity.action}`) : activity.action}
                          </span>
                          {activity.targetTitle && (
                            activity.targetType === 'task' && activity.targetId ? (
                              <button
                                onClick={() => navigate(`/?taskId=${activity.targetId}`)}
                                className="text-sm text-blue-600 hover:text-blue-800 hover:underline truncate"
                              >
                                {t('settings.agentActivity.dashPrefix')} {activity.targetTitle}
                              </button>
                            ) : (
                              <span className="text-sm text-zinc-600 dark:text-zinc-300 truncate">
                                {t('settings.agentActivity.dashPrefix')} {activity.targetTitle}
                              </span>
                            )
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
                          <span>{formatTime(activity.createdAt)}</span>
                          {agent && (
                            <>
                              <span>{t('settings.agentActivity.pipeSeparator')}</span>
                              <div className="flex items-center gap-1.5">
                                <UserAvatar
                                  username={agent.nickname}
                                  avatar={agent.avatar}
                                  size="sm"
                                />
                                <span>{agent.nickname}</span>
                              </div>
                            </>
                          )}
                          {activity.ipAddress && (
                            <>
                              <span>{t('settings.agentActivity.pipeSeparator')}</span>
                              <span>{t('settings.agentActivity.ipAddress')} {activity.ipAddress}</span>
                            </>
                          )}
                          {activity.source && (
                            <>
                              <span>{t('settings.agentActivity.pipeSeparator')}</span>
                              <span className={`font-medium ${
                                activity.source === 'mcp' ? 'text-green-600' : 'text-blue-600'
                              }`}>
                                {activity.source === 'mcp' ? t('settings.agentActivity.sourceMcp') : t('settings.agentActivity.sourceWeb')}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {isLoadingMore && (
                  <div className="flex justify-center py-4">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"></div>
                  </div>
                )}
                {!hasMore && activities.length > 0 && (
                  <div className="text-center py-4 text-sm text-zinc-400 dark:text-zinc-500">
                    {t('settings.noMoreActivities')}
                  </div>
                )}
              </div>
            )}
          </div>

          {!isAtBottom && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
              <button
                onClick={() => {
                  if (logContainerRef.current) {
                    logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                    setIsAtBottom(true);
                  }
                }}
                className="rounded-full bg-blue-500 px-4 py-2 text-sm text-white shadow-lg hover:bg-blue-600"
              >
                ↓ {t('settings.agentActivity.scrollToBottom')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}