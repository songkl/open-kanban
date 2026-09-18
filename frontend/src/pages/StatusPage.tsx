import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { statusApi, type StatusReport } from '../services/api';

const POLL_INTERVAL_MS = 30_000;

type StatusLevel = 'ok' | 'degraded' | 'error' | 'loading';

interface BadgeStyle {
  bg: string;
  text: string;
  border: string;
  label: string;
}

function statusBadge(level: StatusLevel, t: (key: string, fallback: string) => string): BadgeStyle {
  switch (level) {
    case 'ok':
      return {
        bg: 'bg-emerald-100 dark:bg-emerald-900/40',
        text: 'text-emerald-800 dark:text-emerald-200',
        border: 'border-emerald-200 dark:border-emerald-800',
        label: t('statusPage.healthy', 'Healthy'),
      };
    case 'degraded':
      return {
        bg: 'bg-amber-100 dark:bg-amber-900/40',
        text: 'text-amber-800 dark:text-amber-200',
        border: 'border-amber-200 dark:border-amber-800',
        label: t('statusPage.degraded', 'Degraded'),
      };
    case 'error':
      return {
        bg: 'bg-red-100 dark:bg-red-900/40',
        text: 'text-red-800 dark:text-red-200',
        border: 'border-red-200 dark:border-red-800',
        label: t('statusPage.unhealthy', 'Unhealthy'),
      };
    case 'loading':
    default:
      return {
        bg: 'bg-zinc-100 dark:bg-zinc-800',
        text: 'text-zinc-700 dark:text-zinc-300',
        border: 'border-zinc-200 dark:border-zinc-700',
        label: t('statusPage.loading', 'Loading…'),
      };
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function formatTimestamp(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return iso;
  }
}

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warn' | 'danger';
  testId?: string;
}

function StatCard({ label, value, hint, tone = 'default', testId }: StatCardProps) {
  const toneClasses =
    tone === 'danger'
      ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
      : tone === 'warn'
        ? 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20'
        : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900';

  return (
    <div
      data-testid={testId}
      className={`rounded-lg border p-4 shadow-sm ${toneClasses}`}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </div>
      <div className="mt-1 break-words text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
        {value}
      </div>
      {hint && (
        <div className="mt-1 break-words text-xs text-zinc-500 dark:text-zinc-400">{hint}</div>
      )}
    </div>
  );
}

export function StatusPage() {
  const { t } = useTranslation();
  const [report, setReport] = useState<StatusReport | null>(null);
  const [level, setLevel] = useState<StatusLevel>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsSincePoll, setSecondsSincePoll] = useState(0);
  const cancelledRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    cancelledRef.current = false;

    const fetchOnce = async () => {
      try {
        const data = await statusApi.get();
        if (cancelledRef.current) return;
        setReport(data);
        setLastUpdated(new Date());
        setSecondsSincePoll(0);
        if (data.status === 'ok') {
          setLevel('ok');
        } else if (data.status === 'degraded') {
          setLevel('degraded');
        } else {
          setLevel('error');
        }
        setError(null);
      } catch (err) {
        if (cancelledRef.current) return;
        setLevel('error');
        setError(err instanceof Error ? err.message : 'Failed to fetch status');
      }
    };

    void fetchOnce();
    timerRef.current = window.setInterval(() => {
      void fetchOnce();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelledRef.current = true;
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setSecondsSincePoll((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(tick);
  }, []);

  const badge = statusBadge(level, t);

  return (
    <div
      className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
      data-testid="status-page"
    >
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
          <Link
            to="/"
            className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            {t('statusPage.backHome', '← Back to Open Kanban')}
          </Link>
          <h1 className="ml-auto text-lg font-semibold sm:ml-0 sm:mr-auto">
            {t('statusPage.title', 'Open Kanban — System Status')}
          </h1>
          <span
            data-testid="status-badge"
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${badge.bg} ${badge.text} ${badge.border}`}
          >
            {badge.label}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {error && level === 'error' && !report && (
          <div
            className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
            data-testid="status-error"
          >
            <div className="font-medium">
              {t('statusPage.fetchFailed', 'Unable to reach the status endpoint.')}
            </div>
            <div className="mt-1 break-words text-xs text-red-700 dark:text-red-300">{error}</div>
          </div>
        )}

        <section className="mb-6" aria-label={t('statusPage.sectionSummary', 'Summary')}>
          <div className="mb-3 flex flex-wrap items-baseline gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <span>
              {t('statusPage.version', 'Version')}: <span className="font-mono">{report?.version ?? '—'}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {t('statusPage.uptime', 'Uptime')}: <span className="font-mono">{formatDuration(report?.uptimeSeconds ?? 0)}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span data-testid="status-last-updated">
              {lastUpdated
                ? t('statusPage.lastUpdated', 'Last updated {{seconds}}s ago', {
                    seconds: secondsSincePoll,
                  })
                : t('statusPage.neverUpdated', 'Awaiting first response…')}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              testId="status-card-db"
              label={t('statusPage.database', 'Database')}
              value={report ? `${report.database.type} ${report.database.version}` : '—'}
              hint={report
                ? report.database.reachable
                  ? t('statusPage.dbReachable', 'Reachable')
                  : t('statusPage.dbUnreachable', 'Unreachable')
                : undefined}
              tone={report && !report.database.reachable ? 'danger' : 'default'}
            />
            <StatCard
              testId="status-card-migration"
              label={t('statusPage.lastMigration', 'Last migration')}
              value={report?.migration.lastVersion || '—'}
              hint={report?.migration.lastAppliedAt
                ? formatTimestamp(report.migration.lastAppliedAt)
                : t('statusPage.noMigration', 'No migrations recorded yet')}
            />
            <StatCard
              testId="status-card-tasks"
              label={t('statusPage.totalTasks', 'Total tasks')}
              value={report?.counts.tasks ?? 0}
              hint={report
                ? t('statusPage.runsLast24h', '{{count}} runs / 24h', {
                    count: report.counts.activitiesLast24h,
                  })
                : undefined}
            />
            <StatCard
              testId="status-card-runs"
              label={t('statusPage.totalRuns', 'Total runs')}
              value={report?.counts.activities ?? 0}
              hint={report
                ? t('statusPage.totalRunsHint', '{{count}} lifetime activities', {
                    count: report.counts.activities,
                  })
                : undefined}
            />
          </div>
        </section>

        <section className="mb-6" aria-label={t('statusPage.sectionAgents', 'Agents')}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {t('statusPage.sectionAgents', 'Agents')}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatCard
              testId="status-card-agents-total"
              label={t('statusPage.agentsTotal', 'Registered agents')}
              value={report?.agents.total ?? 0}
            />
            <StatCard
              testId="status-card-agents-active"
              label={t('statusPage.agentsActive', 'Active (last 5 min)')}
              value={report?.agents.active ?? 0}
              tone={report && report.agents.total > 0 && report.agents.active === 0 ? 'warn' : 'default'}
              hint={
                report && report.agents.total > 0 && report.agents.active === 0
                  ? t('statusPage.agentsIdle', 'No recent agent activity')
                  : undefined
              }
            />
          </div>
        </section>

        <section className="mb-6" aria-label={t('statusPage.sectionWebhook', 'Webhook delivery')}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {t('statusPage.sectionWebhook', 'Webhook delivery')}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatCard
              testId="status-card-webhook-state"
              label={t('statusPage.webhookState', 'Webhook')}
              value={
                report
                  ? report.webhook.enabled
                    ? t('statusPage.webhookEnabled', 'Enabled')
                    : t('statusPage.webhookDisabled', 'Disabled')
                  : '—'
              }
              hint={report
                ? report.webhook.enabled
                  ? t('statusPage.webhookConfigured', 'Outbound notifications are configured')
                  : t('statusPage.webhookNotConfigured', 'WEBHOOK_ENABLED is not set to true')
                : undefined}
            />
            <StatCard
              testId="status-card-webhook-failures"
              label={t('statusPage.webhookFailures', 'Failures (24h)')}
              value={report?.webhook.recentFailures ?? 0}
              hint={report?.webhook.lastFailureAt
                ? `${t('statusPage.lastFailure', 'Last failure')}: ${formatTimestamp(report.webhook.lastFailureAt)}`
                : t('statusPage.noFailures', 'No recent failures')}
              tone={
                report && report.webhook.enabled && report.webhook.recentFailures > 0
                  ? 'warn'
                  : 'default'
              }
            />
          </div>
        </section>

        <footer className="mt-8 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <span>
            {t(
              'statusPage.polling',
              'This page polls /api/v1/status every 30 seconds. No login required.'
            )}
          </span>
        </footer>
      </main>
    </div>
  );
}
