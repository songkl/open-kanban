import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createErrorReporter,
  getDefaultConfig,
  type Reporter,
} from '../services/errorReporter';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Override the reporter singleton (used by tests). */
  reporter?: Reporter;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/**
 * ErrorBoundary — wraps the React tree and forwards any
 * uncaught render-time error to the global error sink
 * (s-1210, PM_REVIEW_2026-09-17 §7).
 *
 * The reporter is created lazily on first construction so
 * the bootstrap path in main.tsx can install the global
 * window listeners BEFORE any component mounts. The boundary
 * itself falls back to a friendly fallback UI so the user is
 * never stranded on a blank white screen.
 *
 * Test isolation: pass an explicit `reporter` prop to inject
 * a stub. Production callers leave it unset.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private static sharedReporter: Reporter | null = null;
  private readonly reporter: Reporter;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: null };
    this.reporter = props.reporter ?? this.getSharedReporter();
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null;
    this.setState({ componentStack });
    void this.reporter.report({
      eventType: 'react_error',
      message: error.message || 'Unknown React render error',
      stack: error.stack,
      url: safeHref(),
      source: 'ErrorBoundary',
      details: {
        componentStack: info.componentStack,
        name: error.name,
      },
    });
  }

  private getSharedReporter(): Reporter {
    if (!ErrorBoundary.sharedReporter) {
      ErrorBoundary.sharedReporter = createErrorReporter(getDefaultConfig());
      ErrorBoundary.sharedReporter.install();
    }
    return ErrorBoundary.sharedReporter;
  }

  private handleReload = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render(): ReactNode {
    if (this.state.error) {
      return <FallbackUI onReload={this.handleReload} />;
    }
    return this.props.children;
  }
}

/**
 * FallbackUI renders the recovery surface when the boundary
 * trips. The UI is intentionally minimal — at this point the
 * rest of the React tree is gone, so i18n may not be wired up
 * yet. We render the language from the next-i18next bundle
 * directly and rely on the bootstrap CSS so the page is
 * legible without the normal app shell.
 */
function FallbackUI({ onReload }: { onReload: () => void }): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-100 p-6 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
        <h1 className="mb-2 text-xl font-semibold">
          {t('app.error.boundaryTitle', 'Something went wrong')}
        </h1>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          {t(
            'app.error.boundaryDescription',
            'The page crashed before it could finish rendering. The error has been reported — you can safely reload to recover.'
          )}
        </p>
        <button
          type="button"
          onClick={onReload}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {t('app.error.retry', 'Retry')}
        </button>
      </div>
    </div>
  );
}

function safeHref(): string {
  try {
    if (typeof window === 'undefined') return '';
    return window.location?.href ?? '';
  } catch {
    return '';
  }
}

/**
 * resetGlobalReporterForTest clears the lazy singleton used by
 * the boundary. Tests that need to assert "the boundary used
 * my stub reporter" call this between cases; production code
 * should never touch it.
 */
export function resetGlobalReporterForTest(): void {
  (ErrorBoundary as unknown as { sharedReporter: Reporter | null }).sharedReporter = null;
}