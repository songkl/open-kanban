import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSetupGuard } from '../hooks/useSetupGuard';
import { ErrorToastContainer } from '../components/ErrorToast';

type ClaimMode = 'mine' | 'board';
type RunnerStatus = 'todo' | 'in_progress' | 'review' | 'done';

interface LocationState {
  agentToken?: string;
}

const STATUSES: RunnerStatus[] = ['todo', 'in_progress', 'review', 'done'];

function quoteShell(value: string): string {
  if (value === '') return "''";
  if (/^[a-zA-Z0-9_\-./:=]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildRunCommand(opts: {
  mode: ClaimMode;
  boardId: string;
  status: RunnerStatus;
  bin: string;
}): string {
  const parts: string[] = ['kanban run'];
  if (opts.mode === 'mine') {
    parts.push('--mine');
  } else {
    parts.push('--board', quoteShell(opts.boardId));
    parts.push('--status', opts.status);
  }
  const bin = opts.bin.trim();
  if (bin) {
    parts.push('--bin', quoteShell(bin));
  }
  return parts.join(' ');
}

/**
 * AgentConfigWizardPage — guided page that walks the user through the
 * `kanban run` setup without leaving the browser (s-1245).
 *
 * UX: three labelled sections:
 *   1. Bind your CLI — display the canonical `kanban auth login` command
 *      with a one-click copy.
 *   2. Configure the runner — radio (claim mode) + conditional inputs
 *      (board id, status, agent binary) feed a live preview.
 *   3. Generated command — single read-only `<code>` plus a copy button
 *      so the user can paste the exact CLI invocation into a terminal.
 *
 * The agent token is optional — the user may have arrived here from
 * the Settings → Agents page rather than the onboarding wizard. When
 * the token is missing we still render the wizard; the generated
 * command does not depend on the token value (it only matters at
 * `kanban auth login` time).
 */
export function AgentConfigWizardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  useSetupGuard();

  const incomingToken =
    (location.state as LocationState | null)?.agentToken ?? '';

  const [token, setToken] = useState(incomingToken);
  const [mode, setMode] = useState<ClaimMode>('mine');
  const [boardId, setBoardId] = useState('');
  const [status, setStatus] = useState<RunnerStatus>('todo');
  const [bin, setBin] = useState('');
  const [copied, setCopied] = useState(false);
  const [authCopied, setAuthCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    if (incomingToken && !token) setToken(incomingToken);
  }, [incomingToken, token]);

  const generatedCommand = useMemo(() => {
    if (mode === 'board' && !boardId.trim()) return '';
    return buildRunCommand({ mode, boardId: boardId.trim(), status, bin: bin.trim() });
  }, [mode, boardId, status, bin]);

  const generatedMissingReason = useMemo(() => {
    if (mode === 'board' && !boardId.trim()) {
      return t('agentConfig.generatedMissingBoard');
    }
    return null;
  }, [mode, boardId, t]);

  const copy = async (text: string, slot: 'run' | 'auth') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
      if (slot === 'run') {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        setAuthCopied(true);
        setTimeout(() => setAuthCopied(false), 2000);
      }
    } catch {
      setCopyError(t('agentConfig.copyFailed'));
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-lg shadow-blue-500/30">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">
              {t('agentConfig.title')}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {t('agentConfig.subtitle')}
            </p>
          </div>
        </div>

        <section className="mb-6 rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-sm border border-zinc-100 dark:border-zinc-700">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
            {t('agentConfig.tokenLabel')}
          </h2>
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('agentConfig.tokenPlaceholder')}
            data-testid="agent-config-token"
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 font-mono text-xs focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
          />
        </section>

        <section className="mb-6 rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-sm border border-zinc-100 dark:border-zinc-700">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            {t('agentConfig.step1')}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
            {t('agentConfig.step1Hint')}
          </p>
          <div className="flex items-center gap-2">
            <code
              data-testid="agent-config-auth-cmd"
              className="flex-1 break-all rounded-md bg-zinc-900 px-3 py-2 text-xs font-mono text-emerald-300"
            >
              kanban auth login
            </code>
            <button
              type="button"
              onClick={() => copy('kanban auth login', 'auth')}
              data-testid="agent-config-auth-copy"
              className="shrink-0 rounded-md bg-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors"
            >
              {authCopied ? t('agentConfig.copied') : t('agentConfig.copy')}
            </button>
          </div>
        </section>

        <section className="mb-6 rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-sm border border-zinc-100 dark:border-zinc-700">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            {t('agentConfig.step2')}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
            {t('agentConfig.step2Hint')}
          </p>

          <fieldset className="mb-5">
            <legend className="mb-2 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              {t('agentConfig.modeLabel')}
            </legend>
            <div className="space-y-2">
              <label className="flex items-start gap-3 cursor-pointer rounded-md border border-zinc-200 dark:border-zinc-600 px-3 py-2 hover:border-blue-400 dark:hover:border-blue-500">
                <input
                  type="radio"
                  name="claim-mode"
                  value="mine"
                  checked={mode === 'mine'}
                  onChange={() => setMode('mine')}
                  data-testid="agent-config-mode-mine"
                  className="mt-1 h-4 w-4 border-zinc-300 text-blue-500 focus:ring-blue-500"
                />
                <span className="text-sm text-zinc-800 dark:text-zinc-100">
                  {t('agentConfig.modeMine')}
                </span>
              </label>
              <label className="flex items-start gap-3 cursor-pointer rounded-md border border-zinc-200 dark:border-zinc-600 px-3 py-2 hover:border-blue-400 dark:hover:border-blue-500">
                <input
                  type="radio"
                  name="claim-mode"
                  value="board"
                  checked={mode === 'board'}
                  onChange={() => setMode('board')}
                  data-testid="agent-config-mode-board"
                  className="mt-1 h-4 w-4 border-zinc-300 text-blue-500 focus:ring-blue-500"
                />
                <span>
                  <span className="block text-sm text-zinc-800 dark:text-zinc-100">
                    {t('agentConfig.modeBoard')}
                  </span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    {t('agentConfig.modeBoardHint')}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {mode === 'board' && (
            <div className="mb-5 grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="agent-config-board"
                  className="mb-2 block text-xs font-medium text-zinc-700 dark:text-zinc-300"
                >
                  {t('agentConfig.boardIdLabel')}
                </label>
                <input
                  id="agent-config-board"
                  type="text"
                  value={boardId}
                  onChange={(e) => setBoardId(e.target.value)}
                  placeholder={t('agentConfig.boardIdPlaceholder')}
                  data-testid="agent-config-board-input"
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                />
              </div>
              <div>
                <label
                  htmlFor="agent-config-status"
                  className="mb-2 block text-xs font-medium text-zinc-700 dark:text-zinc-300"
                >
                  {t('agentConfig.statusLabel')}
                </label>
                <select
                  id="agent-config-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as RunnerStatus)}
                  data-testid="agent-config-status-select"
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`agentConfig.status${s.charAt(0).toUpperCase()}${s.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div>
            <label
              htmlFor="agent-config-bin"
              className="mb-2 block text-xs font-medium text-zinc-700 dark:text-zinc-300"
            >
              {t('agentConfig.binLabel')}
            </label>
            <input
              id="agent-config-bin"
              type="text"
              value={bin}
              onChange={(e) => setBin(e.target.value)}
              placeholder={t('agentConfig.binPlaceholder')}
              data-testid="agent-config-bin-input"
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
            />
          </div>
        </section>

        <section className="mb-6 rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-sm border border-zinc-100 dark:border-zinc-700">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            {t('agentConfig.step3')}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
            {t('agentConfig.step3Hint')}
          </p>
          {generatedMissingReason ? (
            <p
              data-testid="agent-config-missing-reason"
              className="rounded-md bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              {generatedMissingReason}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <code
                data-testid="agent-config-generated"
                className="flex-1 break-all rounded-md bg-zinc-900 px-3 py-2 text-xs font-mono text-emerald-300"
              >
                {generatedCommand}
              </code>
              <button
                type="button"
                onClick={() => copy(generatedCommand, 'run')}
                disabled={!generatedCommand}
                data-testid="agent-config-run-copy"
                className="shrink-0 rounded-md bg-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {copied ? t('agentConfig.copied') : t('agentConfig.copy')}
              </button>
            </div>
          )}
          {copyError && (
            <p
              data-testid="agent-config-copy-error"
              className="mt-2 text-xs text-red-600 dark:text-red-400"
            >
              {copyError}
            </p>
          )}
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            {t('agentConfig.docsHint')}
          </p>
        </section>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => navigate('/boards')}
            data-testid="agent-config-back"
            className="rounded-xl bg-zinc-100 dark:bg-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
          >
            {t('common.back')}
          </button>
        </div>
      </div>
      <ErrorToastContainer />
    </div>
  );
}