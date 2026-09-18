import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary, resetGlobalReporterForTest } from './ErrorBoundary';
import type { Reporter } from '../services/errorReporter';

function makeStubReporter(): Reporter & { reported: ReturnType<typeof vi.fn> } {
  const reported = vi.fn().mockResolvedValue(undefined);
  return {
    reported,
    report: reported,
    isEnabled: () => true,
    setEnabled: () => undefined,
    redact: (s: string) => s,
    install: () => undefined,
    uninstall: () => undefined,
  } as unknown as Reporter & { reported: ReturnType<typeof vi.fn> };
}

describe('ErrorBoundary (s-1210)', () => {
  beforeEach(() => {
    resetGlobalReporterForTest();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">hello</div>
      </ErrorBoundary>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('renders the fallback UI when a child throws', () => {
    const reporter = makeStubReporter();
    const Throwing = () => {
      throw new Error('boom');
    };
    // React logs the error in the test environment; silence the
    // console noise so the test output stays clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary reporter={reporter}>
        <Throwing />
      </ErrorBoundary>
    );
    expect(screen.getByText('app.error.retry')).toBeInTheDocument();
    expect(reporter.reported).toHaveBeenCalledTimes(1);
    const payload = reporter.reported.mock.calls[0][0];
    expect(payload.eventType).toBe('react_error');
    expect(payload.message).toContain('boom');
    consoleError.mockRestore();
  });

  it('reports the componentStackName in the details blob', () => {
    const reporter = makeStubReporter();
    const Throwing = () => {
      throw new Error('with stack');
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary reporter={reporter}>
        <Throwing />
      </ErrorBoundary>
    );
    const payload = reporter.reported.mock.calls[0][0];
    expect(payload.details).toBeDefined();
    expect(payload.details.componentStack).toEqual(expect.any(String));
    consoleError.mockRestore();
  });
});