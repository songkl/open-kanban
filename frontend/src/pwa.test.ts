import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('pwa.registerServiceWorker', () => {
  let originalNavigator: typeof globalThis.navigator;
  let originalWindow: typeof globalThis.window;
  let originalIsSecureContext: boolean | undefined;
  let originalLocation: Location;

  beforeEach(() => {
    vi.resetModules();
    originalNavigator = globalThis.navigator;
    originalWindow = globalThis.window;
    originalIsSecureContext = (globalThis as unknown as { isSecureContext?: boolean })
      .isSecureContext;
    originalLocation = globalThis.location;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    if (originalIsSecureContext === undefined) {
      delete (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext;
    } else {
      Object.defineProperty(globalThis, 'isSecureContext', {
        value: originalIsSecureContext,
        configurable: true,
        writable: true,
      });
    }
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  function makeWindow(opts: {
    secureContext: boolean;
    hostname?: string;
    hasServiceWorker?: boolean;
  }) {
    const listeners: Record<string, Array<() => void>> = {};
    const swRegister = vi.fn().mockResolvedValue(undefined);

    const fakeNavigator = {
      serviceWorker: opts.hasServiceWorker === false ? undefined : { register: swRegister },
    };

    const fakeWindow = {
      isSecureContext: opts.secureContext,
      location: { hostname: opts.hostname ?? 'example.com' },
      addEventListener: (event: string, cb: () => void) => {
        (listeners[event] ||= []).push(cb);
      },
      fireLoad: () => (listeners.load ?? []).forEach((cb) => cb()),
      _swRegister: swRegister,
    };

    Object.defineProperty(globalThis, 'window', {
      value: fakeWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'isSecureContext', {
      value: opts.secureContext,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: fakeNavigator,
      configurable: true,
      writable: true,
    });

    return fakeWindow as unknown as Window & {
      fireLoad: () => void;
      _swRegister: ReturnType<typeof vi.fn>;
    };
  }

  it('skips registration when navigator.serviceWorker is unavailable', async () => {
    // Replace navigator with a version that lacks `serviceWorker`. The
    // pwa helper must short-circuit instead of throwing on `sw.register`.
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'isSecureContext', {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        isSecureContext: true,
        location: { hostname: 'example.com' },
        addEventListener: () => {},
      },
      configurable: true,
      writable: true,
    });

    const { registerServiceWorker } = await import('./pwa');
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it('skips registration when not served from a secure context', async () => {
    const w = makeWindow({ secureContext: false, hostname: 'insecure.example.com' });
    const { registerServiceWorker } = await import('./pwa');
    registerServiceWorker();
    w.fireLoad();
    expect(w._swRegister).not.toHaveBeenCalled();
  });

  it('registers /sw.js with scope / on a secure context', async () => {
    const w = makeWindow({ secureContext: true, hostname: 'kanban.example.com' });
    const { registerServiceWorker } = await import('./pwa');
    registerServiceWorker();
    w.fireLoad();
    expect(w._swRegister).toHaveBeenCalledTimes(1);
    expect(w._swRegister).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('registers on http://localhost for local dev', async () => {
    const w = makeWindow({ secureContext: false, hostname: 'localhost' });
    const { registerServiceWorker } = await import('./pwa');
    registerServiceWorker();
    w.fireLoad();
    expect(w._swRegister).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('registers on http://127.0.0.1 for local dev', async () => {
    const w = makeWindow({ secureContext: false, hostname: '127.0.0.1' });
    const { registerServiceWorker } = await import('./pwa');
    registerServiceWorker();
    w.fireLoad();
    expect(w._swRegister).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('waits for the window load event before registering', async () => {
    const w = makeWindow({ secureContext: true, hostname: 'kanban.example.com' });
    const { registerServiceWorker } = await import('./pwa');

    registerServiceWorker();
    expect(w._swRegister).not.toHaveBeenCalled();

    w.fireLoad();
    expect(w._swRegister).toHaveBeenCalledTimes(1);
  });

  it('does not throw when service worker registration rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = makeWindow({ secureContext: true, hostname: 'kanban.example.com' });
    w._swRegister.mockRejectedValueOnce(new Error('install failed'));
    const { registerServiceWorker } = await import('./pwa');

    registerServiceWorker();
    w.fireLoad();
    // The .catch() handler is async; wait one microtask tick so the
    // warn() call inside it lands before we assert.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });
});
