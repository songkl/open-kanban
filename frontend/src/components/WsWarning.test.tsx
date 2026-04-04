import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WsWarning } from './WsWarning';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      if (key === 'wsStatus.connectionLost') return 'Connection Lost';
      if (key === 'wsStatus.connectionFailed') return 'Connection Failed';
      if (key === 'wsStatus.reconnecting') return `Reconnecting (${options?.attempt}/${options?.max})`;
      if (key === 'wsStatus.retryNow') return 'Retry Now';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('WsWarning', () => {
  it('renders nothing when wsStatus is connected', () => {
    const { container } = render(
      <WsWarning wsStatus="connected" reconnectCount={0} onConnectWebSocket={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders warning when wsStatus is disconnected', () => {
    render(<WsWarning wsStatus="disconnected" reconnectCount={3} onConnectWebSocket={vi.fn()} />);
    expect(screen.getByText('Connection Lost')).toBeInTheDocument();
  });

  it('renders warning when wsStatus is failed', () => {
    render(<WsWarning wsStatus="failed" reconnectCount={5} onConnectWebSocket={vi.fn()} />);
    expect(screen.getByText('Connection Failed')).toBeInTheDocument();
  });

  it('shows reconnect count when greater than 0', () => {
    render(<WsWarning wsStatus="disconnected" reconnectCount={3} onConnectWebSocket={vi.fn()} />);
    expect(screen.getByText(/Reconnecting \(3\/10\)/)).toBeInTheDocument();
  });

  it('calls onConnectWebSocket when retry button is clicked', () => {
    const onConnect = vi.fn();
    render(<WsWarning wsStatus="disconnected" reconnectCount={3} onConnectWebSocket={onConnect} />);
    const retryButton = screen.getByText('Retry Now');
    fireEvent.click(retryButton);
    expect(onConnect).toHaveBeenCalled();
  });
});