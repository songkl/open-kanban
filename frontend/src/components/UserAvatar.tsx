interface UserAvatarProps {
  username?: string;
  avatar?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  onClick?: () => void;
}

const SIZE_CLASSES = {
  sm: 'h-6 w-6 text-xs',
  md: 'h-8 w-8 text-sm',
  lg: 'h-16 w-16 text-xl',
};

function getColorFromUsername(username: string): string {
  const colors = [
    'bg-red-500',
    'bg-orange-500',
    'bg-amber-500',
    'bg-yellow-500',
    'bg-lime-500',
    'bg-green-500',
    'bg-emerald-500',
    'bg-teal-500',
    'bg-cyan-500',
    'bg-sky-500',
    'bg-blue-500',
    'bg-indigo-500',
    'bg-violet-500',
    'bg-purple-500',
    'bg-fuchsia-500',
    'bg-pink-500',
    'bg-rose-500',
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

export function UserAvatar({ username = '', avatar, size = 'md', className = '', onClick }: UserAvatarProps) {
  const clickable = !!onClick;
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={username}
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
      className={`flex items-center justify-center rounded-full font-medium text-white ${bgColor} ${SIZE_CLASSES[size]} ${clickable ? 'cursor-pointer' : ''} ${className}`}
    >
      {initial}
    </div>
  );
}