export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  const isSecureContext =
    window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';
  if (!isSecureContext) return;

  // Use /sw.js at the scope root so it can intercept navigation requests
  // for every route under `/`. The { scope: '/' } default applies because
  // the SW URL sits at the root.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => {
        // Service worker registration is best-effort; failure must never
        // break the app shell. Log for diagnostics and move on.
        console.warn('[pwa] service worker registration failed:', err);
      });
  });
}
