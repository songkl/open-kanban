import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export interface SidebarItem {
  /** Path the item links to. Used by `NavLink` to compute the
   *  active state; pass an empty string to disable the highlight. */
  to: string;
  /** i18n key under `nav.*`. Translation is read via `t(key)`. */
  labelKey: string;
  /** SVG path "d" attribute for the icon. Kept as a tiny path
   *  string (no full SVG markup) so the sidebar component owns
   *  the icon styling consistently across all entries. */
  iconPath: string;
  /** Optional badge count (e.g. unread notifications). Rendered
   *  in the bottom-right of the icon when truthy. */
  badge?: number;
}

interface SidebarProps {
  items: SidebarItem[];
}

/**
 * Persistent 64px icon-only sidebar (s-1194, PM_REVIEW_2026-09-17
 * §5.2 ROI #2). Replaces the previous "Back" buttons by surfacing
 * the five primary authenticated surfaces as one-click targets.
 *
 * The sidebar is intentionally icon-only on desktop (no labels)
 * to keep the visual footprint under the 64px width budget the
 * spec mandates. Hovering any item reveals the i18n label as a
 * tooltip via the `title` attribute, so keyboard users and
 * screen readers still get the full text via standard a11y
 * attributes (`aria-label`, `aria-current`).
 *
 * Active state is computed by React Router's `NavLink`, so the
 * sidebar works correctly with deep-link navigation without any
 * extra wiring on the page side.
 */
export function Sidebar({ items }: SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside
      className="hidden md:flex w-16 flex-col items-center gap-1 border-r border-zinc-200 bg-white py-4 dark:border-zinc-700 dark:bg-zinc-800"
      aria-label={t('nav.sidebar')}
    >
      {items.map((item) => {
        const badge = typeof item.badge === 'number' && item.badge > 0 ? item.badge : undefined;
        const label = t(item.labelKey);
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/boards' || item.to === '/dashboard'}
            aria-label={label}
            title={label}
            data-testid={`sidebar-item-${item.labelKey.replace(/\./g, '-')}`}
            className={({ isActive }) =>
              [
                'relative flex h-12 w-12 items-center justify-center rounded-lg transition-colors',
                isActive
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200',
              ].join(' ')
            }
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={item.iconPath} />
            </svg>
            {badge !== undefined && (
              <span
                data-testid={`sidebar-badge-${item.labelKey.replace(/\./g, '-')}`}
                className="absolute -bottom-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
                aria-label={t('notifications.unreadBadge', { count: badge })}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </NavLink>
        );
      })}
    </aside>
  );
}