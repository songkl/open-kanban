interface UserAvatarProps {
  username?: string;
  avatar?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  onClick?: () => void;
  title?: string;
}

const SIZE_CLASSES = {
  sm: 'h-6 w-6 text-xs',
  md: 'h-8 w-8 text-sm',
  lg: 'h-16 w-16 text-xl',
};

function getColorFromUsername(username: string): string {
  const colors = [
    'bg-red-500 dark:bg-red-700',
    'bg-orange-500 dark:bg-orange-700',
    'bg-amber-500 dark:bg-amber-700',
    'bg-yellow-500 dark:bg-yellow-700',
    'bg-lime-500 dark:bg-lime-700',
    'bg-green-500 dark:bg-green-700',
    'bg-emerald-500 dark:bg-emerald-700',
    'bg-teal-500 dark:bg-teal-700',
    'bg-cyan-500 dark:bg-cyan-700',
    'bg-sky-500 dark:bg-sky-700',
    'bg-blue-500 dark:bg-blue-700',
    'bg-indigo-500 dark:bg-indigo-700',
    'bg-violet-500 dark:bg-violet-700',
    'bg-purple-500 dark:bg-purple-700',
    'bg-fuchsia-500 dark:bg-fuchsia-700',
    'bg-pink-500 dark:bg-pink-700',
    'bg-rose-500 dark:bg-rose-700',
  ];

  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

function getInitial(username: string): string {
  if (!username) return '?';
  return username.charAt(0).toUpperCase();
}

export function UserAvatar({ username = '', avatar, size = 'md', className = '', onClick, title }: UserAvatarProps) {
  const clickable = !!onClick;
  const resolvedTitle = title ?? username;
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={username}
        title={resolvedTitle || undefined}
        onClick={onClick}
        className={`rounded-full object-cover ${SIZE_CLASSES[size]} ${clickable ? 'cursor-pointer' : ''} ${className}`}
      />
    );
  }

  const bgColor = getColorFromUsername(username);
  const initial = getInitial(username);

  return (
    <div
      onClick={onClick}
      title={resolvedTitle || undefined}
      className={`flex items-center justify-center rounded-full font-medium text-white ${bgColor} ${SIZE_CLASSES[size]} ${clickable ? 'cursor-pointer' : ''} ${className}`}
    >
      {initial}
    </div>
  );
}