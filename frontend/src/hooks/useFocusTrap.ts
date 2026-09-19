import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  'iframe',
  'object',
  'embed',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

export interface UseFocusTrapOptions {
  enabled?: boolean;
  initialFocus?: 'first' | 'container' | HTMLElement;
  restoreFocus?: boolean;
  onEscape?: () => void;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && el.tagName !== 'INPUT' && el.tagName !== 'BUTTON') {
      return false;
    }
    return true;
  });
}

export function useFocusTrap<T extends HTMLElement>(
  options: UseFocusTrapOptions = {}
): React.RefObject<T> {
  const { enabled = true, initialFocus = 'first', restoreFocus = true, onEscape } = options;
  const containerRef = useRef<T>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;

    const container = containerRef.current;
    if (!container) return undefined;

    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;

    const focusInitial = () => {
      if (initialFocus instanceof HTMLElement) {
        initialFocus.focus();
        return;
      }
      if (initialFocus === 'container') {
        container.focus();
        return;
      }
      const focusables = getFocusableElements(container);
      const first = focusables[0];
      if (first instanceof HTMLElement) {
        first.focus();
      } else {
        container.tabIndex = container.tabIndex >= 0 ? container.tabIndex : -1;
        container.focus();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape) {
        event.stopPropagation();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    focusInitial();
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (restoreFocus && restoreRef.current && typeof restoreRef.current.focus === 'function') {
        restoreRef.current.focus();
      }
    };
  }, [enabled, initialFocus, onEscape, restoreFocus]);

  return containerRef as React.RefObject<T>;
}
