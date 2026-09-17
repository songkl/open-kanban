import { useLocation, useNavigate } from 'react-router-dom';
import { Sidebar, type SidebarItem } from './Sidebar';
import { NotificationBell } from './NotificationBell';
import { useNotifications } from '../hooks/useNotifications';

/**
 * AppShell — top-level layout for every authenticated route
 * (s-1194, PM_REVIEW_2026-09-17 §5.2 ROI #2).
 *
 * Wraps the page content with the persistent 64px sidebar and
 * mounts the notification bell in the top-right corner. The shell
 * is intentionally minimal — it does not own the WebSocket
 * itself; that responsibility lives in {@link useNotifications},
 * which opens a single socket per page and feeds both the
 * notification subscription and the existing board refresh
 * handler.
 *
 * Children are rendered inside a scroll container so individual
 * pages don't need to repeat the h-screen + overflow boilerplate.
 */
interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();

  useNotifications({ pollIntervalMs: 30_000 });

  const items: SidebarItem[] = [
    {
      to: '/dashboard',
      labelKey: 'nav.sidebarDashboard',
      iconPath: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    },
    {
      to: '/boards',
      labelKey: 'nav.sidebarBoards',
      iconPath: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    },
    {
      to: '/search',
      labelKey: 'nav.sidebarSearch',
      iconPath: 'M21 21l-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z',
    },
    {
      to: '/agent-activity',
      labelKey: 'nav.sidebarAgents',
      iconPath: 'M12 2a4 4 0 0 0-4 4v1a4 4 0 1 0 8 0V6a4 4 0 0 0-4-4zM4 22a8 8 0 0 1 16 0',
    },
    {
      to: '/activities',
      labelKey: 'nav.sidebarActivity',
      iconPath: 'M3 12h4l3-9 4 18 3-9h4',
    },
    {
      to: '/runs',
      labelKey: 'nav.sidebarRuns',
      iconPath: 'M5 3l14 9-14 9V3z',
    },
    {
      to: '/settings',
      labelKey: 'nav.sidebarSettings',
      iconPath: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    },
  ];

  const isSearchRoute = location.pathname.startsWith('/search');

  return (
    <div className="flex h-screen w-screen bg-zinc-100 dark:bg-zinc-900">
      <Sidebar items={items} />
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div className="absolute right-4 top-4 z-40 flex items-center gap-2">
          <NotificationBell
            onSelect={(n) => {
              if (n.targetType === 'TASK' && n.targetId) {
                navigate(`/board/_/tasks/${n.targetId}`);
              }
              if (isSearchRoute) {
                navigate('/boards');
              }
            }}
          />
        </div>
        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}