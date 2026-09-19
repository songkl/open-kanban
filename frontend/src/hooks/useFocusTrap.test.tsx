import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { useFocusTrap } from './useFocusTrap';

interface TrapHarnessProps {
  enabled?: boolean;
  onEscape?: () => void;
  restoreFocus?: boolean;
}

function TrapHarness(props: TrapHarnessProps) {
  const { enabled = true, onEscape, restoreFocus = true } = props;
  const ref = useFocusTrap<HTMLDivElement>({ enabled, onEscape, restoreFocus });
  return (
    <div>
      <button>outside-before</button>
      <div ref={ref} data-testid="trap">
        <button>first</button>
        <button>middle</button>
        <input type="text" />
        <button>last</button>
      </div>
      <button>outside-after</button>
    </div>
  );
}

function TrapHarnessWithoutFocusable({ enabled = true }: { enabled?: boolean }) {
  const ref = useFocusTrap<HTMLDivElement>({ enabled });
  return (
    <div ref={ref} data-testid="trap-no-focusables">
      <p>no focusable elements</p>
    </div>
  );
}

function DisabledTrapHarness() {
  const ref = useFocusTrap<HTMLDivElement>({ enabled: false });
  return (
    <div>
      <button>outside-before</button>
      <div ref={ref} data-testid="disabled-trap">
        <button>inside</button>
      </div>
      <button>outside-after</button>
    </div>
  );
}

function DynamicHarness() {
  const [open, setOpen] = useState(true);
  const ref = useFocusTrap<HTMLDivElement>({ enabled: open });
  return (
    <div>
      <button onClick={() => setOpen(false)}>close</button>
      {open && (
        <div ref={ref} data-testid="dynamic">
          <button>first</button>
          <button>last</button>
        </div>
      )}
    </div>
  );
}

describe('useFocusTrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the first focusable element when the trap activates', () => {
    render(<TrapHarness />);
    const first = screen.getByRole('button', { name: 'first' });
    expect(document.activeElement).toBe(first);
  });

  it('cycles focus forward with Tab when the last element is active', () => {
    render(<TrapHarness />);
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    const first = screen.getByRole('button', { name: 'first' });
    expect(document.activeElement).toBe(first);
  });

  it('cycles focus backward with Shift+Tab when the first element is active', () => {
    render(<TrapHarness />);
    const first = screen.getByRole('button', { name: 'first' });
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    const last = screen.getByRole('button', { name: 'last' });
    expect(document.activeElement).toBe(last);
  });

  it('invokes onEscape when the Escape key is pressed', () => {
    const onEscape = vi.fn();
    render(<TrapHarness onEscape={onEscape} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onEscape for unrelated keys', () => {
    const onEscape = vi.fn();
    render(<TrapHarness onEscape={onEscape} />);
    fireEvent.keyDown(document, { key: 'a' });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('restores focus to the previously focused element on unmount', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<TrapHarness />);
    const first = screen.getByRole('button', { name: 'first' });
    expect(document.activeElement).toBe(first);

    unmount();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not restore focus when restoreFocus is false', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(<TrapHarness restoreFocus={false} />);
    unmount();
    expect(document.activeElement).not.toBe(trigger);
  });

  it('does nothing when disabled', () => {
    render(<DisabledTrapHarness />);
    expect(document.body.contains(document.activeElement)).toBe(true);
  });

  it('prevents Tab from leaving when no focusables are inside the container', () => {
    render(<TrapHarnessWithoutFocusable />);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('attaches the ref to the trap container', () => {
    render(<DynamicHarness />);
    expect(screen.getByTestId('dynamic')).toBeInTheDocument();
  });
});
