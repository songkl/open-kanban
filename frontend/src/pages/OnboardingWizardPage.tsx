import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  presetTemplatesApi,
  onboardingApi,
  type PresetTemplate,
} from '../services/api';
import { useSetupGuard } from '../hooks/useSetupGuard';
import { ErrorToastContainer } from '../components/ErrorToast';

type Step = 'pick' | 'configure' | 'run' | 'done';

interface QuickstartFormState {
  presetSlug: string;
  boardName: string;
  installAgent: boolean;
  triggerDemoRun: boolean;
}

/**
 * OnboardingWizardPage — the first-login wizard (s-1196,
 * PM_REVIEW_2026-09-17 §5.4 ROI #4).
 *
 * UX: three visible steps + a brief "done" celebration.
 *   1. Pick      — choose one of the curated marketplace presets.
 *   2. Configure — optional: rename the board, decide whether to install
 *                  the sample Agent and trigger a demo run. Defaults
 *                  match the "one click" promise so the user can just
 *                  hit "Create".
 *   3. Run       — POST /api/v1/onboarding/quickstart renders a
 *                  progress state while the server materialises the
 *                  board + sample agent + demo task in one transaction.
 *   4. Done      — celebratory screen with the freshly-created board
 *                  link + agent token copy-to-clipboard button.
 *
 * The wizard can be entered from three places:
 *   - The empty BoardsPage (the "Import from template" CTA links here).
 *   - The TemplateMarketplacePage (each card's "Use this template" CTA
 *     pre-selects the slug via ?preset=<slug>).
 *   - The sidebar / settings page (no preset pre-selected).
 *
 * When the URL carries ?preset=<slug>, we jump straight to the
 * "configure" step with that preset locked in.
 */
export function OnboardingWizardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  useSetupGuard();

  const presetFromUrl = searchParams.get('preset') || '';

  const [step, setStep] = useState<Step>(presetFromUrl ? 'configure' : 'pick');
  const [presets, setPresets] = useState<PresetTemplate[]>([]);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<QuickstartFormState>({
    presetSlug: presetFromUrl,
    boardName: '',
    installAgent: true,
    triggerDemoRun: true,
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    boardId: string;
    boardName: string;
    agentId?: string;
    agentToken?: string;
    demoTaskId?: string;
  } | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [cmdCopied, setCmdCopied] = useState<null | 'login' | 'init' | 'run'>(null);

  const copyText = useCallback(async (text: string, slot: 'login' | 'init' | 'run') => {
    try {
      await navigator.clipboard.writeText(text);
      setCmdCopied(slot);
      setTimeout(() => setCmdCopied((current) => (current === slot ? null : current)), 2000);
    } catch {
      setSubmitError(t('onboarding.copyFailed'));
    }
  }, [t]);

  const fetchPresets = useCallback(async () => {
    setLoadingPresets(true);
    setLoadError(null);
    try {
      const data = await presetTemplatesApi.getAll();
      setPresets(data || []);
      // If the URL pre-selected a preset, default the board name to the
      // preset's display name so the configure form is pre-filled.
      if (presetFromUrl) {
        const match = data.find((p) => p.slug === presetFromUrl);
        if (match) {
          setForm((prev) => ({ ...prev, boardName: match.name }));
        }
      }
    } catch (err) {
      console.error('Failed to load preset templates:', err);
      setLoadError(err instanceof Error ? err.message : t('app.error.loadFailed'));
    } finally {
      setLoadingPresets(false);
    }
  }, [presetFromUrl, t]);

  useEffect(() => {
    fetchPresets();
  }, [fetchPresets]);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.slug === form.presetSlug) || null,
    [presets, form.presetSlug]
  );

  const handleSelectPreset = (preset: PresetTemplate) => {
    setForm((prev) => ({
      ...prev,
      presetSlug: preset.slug,
      boardName: prev.boardName || preset.name,
    }));
    setStep('configure');
  };

  const handleSubmit = async () => {
    if (!form.presetSlug) {
      setSubmitError(t('onboarding.presetRequired'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const data = await onboardingApi.quickstart({
        presetSlug: form.presetSlug,
        boardName: form.boardName.trim() || undefined,
        installAgent: form.installAgent,
        triggerDemoRun: form.triggerDemoRun,
      });
      setResult(data);
      setStep('done');
    } catch (err) {
      console.error('Quickstart failed:', err);
      setSubmitError(err instanceof Error ? err.message : t('app.error.requestFailed', { status: '' }));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyToken = async () => {
    if (!result?.agentToken) return;
    try {
      await navigator.clipboard.writeText(result.agentToken);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      // Clipboard write may be denied in some browsers; surface a
      // soft toast rather than blocking the flow.
      setSubmitError(t('onboarding.copyFailed'));
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-purple-600 text-white shadow-lg shadow-purple-500/30">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">
              {t('onboarding.title')}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {t('onboarding.subtitle')}
            </p>
          </div>
        </div>

        <Stepper current={step} />

        {loadError && (
          <div className="mb-6 rounded-xl bg-amber-50 dark:bg-amber-900/30 p-4 text-sm text-amber-700 dark:text-amber-300">
            {t('onboarding.presetLoadFailed')}: {loadError}
          </div>
        )}

        {step === 'pick' && (
          <section className="rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-sm border border-zinc-100 dark:border-zinc-700">
            <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100 mb-2">
              {t('onboarding.step1Title')}
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
              {t('onboarding.step1Hint')}
            </p>

            {loadingPresets ? (
              <div className="py-8 text-center">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
              </div>
            ) : presets.length === 0 ? (
              <div className="rounded-xl bg-zinc-50 dark:bg-zinc-700/50 p-6 text-center">
                <p className="text-sm text-zinc-600 dark:text-zinc-300">
                  {t('onboarding.noPresetsAvailable')}
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/boards')}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-zinc-100 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
                >
                  {t('onboarding.skipToBoards')}
                </button>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleSelectPreset(preset)}
                    className="group rounded-xl bg-zinc-50 dark:bg-zinc-700/50 p-4 text-left border border-zinc-200 dark:border-zinc-600 hover:border-purple-400 dark:hover:border-purple-500 hover:shadow-md transition-all"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-300">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="7" height="7" rx="1" />
                          <rect x="14" y="3" width="7" height="7" rx="1" />
                          <rect x="3" y="14" width="7" height="7" rx="1" />
                          <rect x="14" y="14" width="7" height="7" rx="1" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-zinc-800 dark:text-zinc-100 truncate">
                          {preset.name}
                        </h3>
                        {preset.category && (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {preset.category}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-sm text-zinc-600 dark:text-zinc-300 line-clamp-2">
                      {preset.description}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {step === 'configure' && selectedPreset && (
          <section className="rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-sm border border-zinc-100 dark:border-zinc-700">
            <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100 mb-2">
              {t('onboarding.step2Title')}
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
              {t('onboarding.step2Hint', { presetName: selectedPreset.name })}
            </p>

            <div className="space-y-5">
              <div>
                <label
                  htmlFor="onboarding-board-name"
                  className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                >
                  {t('onboarding.boardNameLabel')}
                </label>
                <input
                  id="onboarding-board-name"
                  type="text"
                  value={form.boardName}
                  onChange={(e) => setForm({ ...form, boardName: e.target.value })}
                  placeholder={selectedPreset.name}
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-purple-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                  maxLength={100}
                />
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {t('onboarding.boardNameHint')}
                </p>
              </div>

              <div className="rounded-xl bg-zinc-50 dark:bg-zinc-700/50 p-4 space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.installAgent}
                    onChange={(e) => setForm({ ...form, installAgent: e.target.checked })}
                    className="mt-1 h-4 w-4 rounded border-zinc-300 text-purple-500 focus:ring-purple-500"
                  />
                  <div>
                    <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">
                      {t('onboarding.installAgentLabel', { agent: selectedPreset.sampleAgent || t('onboarding.sampleAgent') })}
                    </span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {t('onboarding.installAgentHint')}
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.triggerDemoRun}
                    onChange={(e) => setForm({ ...form, triggerDemoRun: e.target.checked })}
                    className="mt-1 h-4 w-4 rounded border-zinc-300 text-purple-500 focus:ring-purple-500"
                  />
                  <div>
                    <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">
                      {t('onboarding.triggerDemoLabel')}
                    </span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {t('onboarding.triggerDemoHint')}
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {submitError && (
              <div className="mt-4 rounded-md bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-600 dark:text-red-400">
                {submitError}
              </div>
            )}

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              {!presetFromUrl && (
                <button
                  type="button"
                  onClick={() => setStep('pick')}
                  disabled={submitting}
                  className="rounded-xl bg-zinc-100 dark:bg-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600 disabled:opacity-50 transition-colors"
                >
                  {t('common.back')}
                </button>
              )}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-500 to-purple-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-500/30 hover:from-purple-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {submitting ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    {t('onboarding.creating')}
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                    {t('onboarding.create')}
                  </>
                )}
              </button>
            </div>
          </section>
        )}

        {step === 'done' && result && (
          <section className="rounded-2xl bg-white dark:bg-zinc-800 p-8 shadow-sm border border-zinc-100 dark:border-zinc-700 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-zinc-800 dark:text-zinc-100 mb-2">
              {t('onboarding.doneTitle')}
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
              {t('onboarding.doneSubtitle', { boardName: result.boardName })}
            </p>

            {result.agentToken && (
              <div className="mb-6 rounded-xl bg-zinc-50 dark:bg-zinc-700/50 p-4 text-left">
                <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                  {t('onboarding.agentTokenLabel')}
                </label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md bg-zinc-900 px-3 py-2 text-xs font-mono text-emerald-300">
                    {result.agentToken}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyToken}
                    data-testid="copy-agent-token"
                    className="shrink-0 rounded-md bg-purple-500 px-3 py-2 text-sm font-medium text-white hover:bg-purple-600 transition-colors"
                  >
                    {tokenCopied ? t('onboarding.copied') : t('onboarding.copy')}
                  </button>
                </div>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {t('onboarding.agentTokenHint')}
                </p>
              </div>
            )}

            {result.agentToken && (
              <div className="mb-6 rounded-xl border border-blue-200 dark:border-blue-700/60 bg-blue-50 dark:bg-blue-900/20 p-4 text-left">
                <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-300 mb-1">
                  {t('onboarding.runAgentSectionTitle')}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                  {t('onboarding.runAgentSectionHint')}
                </p>
                <ul className="space-y-3">
                  <li>
                    <p className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      {t('onboarding.runAgentStep1Label')}
                    </p>
                    <div className="flex items-center gap-2">
                      <code
                        data-testid="cmd-login"
                        className="flex-1 break-all rounded-md bg-zinc-900 px-3 py-2 text-xs font-mono text-emerald-300"
                      >
                        kanban auth login
                      </code>
                      <button
                        type="button"
                        onClick={() => copyText('kanban auth login', 'login')}
                        className="shrink-0 rounded-md bg-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors"
                      >
                        {cmdCopied === 'login' ? t('onboarding.copied') : t('onboarding.copy')}
                      </button>
                    </div>
                  </li>
                  <li>
                    <p className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      {t('onboarding.runAgentStep2Label')}
                    </p>
                    <div className="flex items-center gap-2">
                      <code
                        data-testid="cmd-init"
                        className="flex-1 break-all rounded-md bg-zinc-900 px-3 py-2 text-xs font-mono text-emerald-300"
                      >
                        kanban run init
                      </code>
                      <button
                        type="button"
                        onClick={() => copyText('kanban run init', 'init')}
                        className="shrink-0 rounded-md bg-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors"
                      >
                        {cmdCopied === 'init' ? t('onboarding.copied') : t('onboarding.copy')}
                      </button>
                    </div>
                  </li>
                  <li>
                    <p className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      {t('onboarding.runAgentStep3Label')}
                    </p>
                    <div className="flex items-center gap-2">
                      <code
                        data-testid="cmd-run"
                        className="flex-1 break-all rounded-md bg-zinc-900 px-3 py-2 text-xs font-mono text-emerald-300"
                      >
                        kanban run --mine
                      </code>
                      <button
                        type="button"
                        onClick={() => copyText('kanban run --mine', 'run')}
                        className="shrink-0 rounded-md bg-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors"
                      >
                        {cmdCopied === 'run' ? t('onboarding.copied') : t('onboarding.copy')}
                      </button>
                    </div>
                  </li>
                </ul>
                <button
                  type="button"
                  onClick={() => navigate('/onboarding/agent-config', { state: { agentToken: result.agentToken } })}
                  className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {t('onboarding.runAgentStep4Action')}
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </button>
                <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {t('onboarding.runAgentStep4Label')}
                </span>
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => navigate(`/board/${result.boardId}`)}
                className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
              >
                {t('onboarding.openBoard')}
              </button>
              <button
                type="button"
                onClick={() => navigate('/boards')}
                className="rounded-xl bg-zinc-100 dark:bg-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
              >
                {t('onboarding.backToBoards')}
              </button>
            </div>
          </section>
        )}
      </div>

      <ErrorToastContainer />
    </div>
  );
}

/**
 * Stepper is a small progress indicator for the wizard. The four
 * states the wizard cycles through (pick → configure → run → done)
 * are presented as four dots; the active dot is purple, completed
 * dots are emerald.
 */
function Stepper({ current }: { current: Step }) {
  const { t } = useTranslation();
  const order: Step[] = ['pick', 'configure', 'done'];
  // We collapse 'run' into 'configure' visually since 'run' is a
  // brief progress state (the button changes to a spinner). This
  // keeps the indicator stable across the actual API call.
  const visualStep: Step = current === 'run' ? 'configure' : current;
  const currentIdx = order.indexOf(visualStep);

  return (
    <div className="mb-6 flex items-center justify-center gap-2">
      {order.map((s, idx) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
              idx < currentIdx
                ? 'bg-emerald-500 text-white'
                : idx === currentIdx
                ? 'bg-purple-500 text-white'
                : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'
            }`}
          >
            {idx < currentIdx ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              idx + 1
            )}
          </div>
          {idx < order.length - 1 && (
            <div
              className={`h-0.5 w-8 transition-colors ${
                idx < currentIdx ? 'bg-emerald-500' : 'bg-zinc-200 dark:bg-zinc-700'
              }`}
            />
          )}
          <span className="sr-only">{t(`onboarding.stepName.${s}`)}</span>
        </div>
      ))}
    </div>
  );
}