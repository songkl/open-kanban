interface DSStoreCardProps {
  title: string;
  subtitle?: string;
  description?: string;
  icon?: string;
  iconUrls?: string[];
  defaultIcon?: string;
  actionText?: string;
  onAction?: () => void;
  onClick?: () => void;
  disabled?: boolean;
}

export function DSStoreCard({
  title,
  subtitle,
  description,
  icon,
  iconUrls,
  defaultIcon,
  actionText,
  onAction,
  onClick,
  disabled,
}: DSStoreCardProps) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      className={`
        rounded-lg border p-4 cursor-pointer transition-all duration-200
        ${disabled
          ? 'border-zinc-200 bg-zinc-50 opacity-60 cursor-not-allowed'
          : 'border-[#E7E7F5] hover:border-blue-500 bg-white'
        }
      `}
    >
      {(icon || iconUrls?.length || defaultIcon) && (
        <div className="mb-3 flex items-center justify-center w-12 h-12 bg-white rounded-lg shadow-sm overflow-hidden">
          {iconUrls?.[0] ? (
            <img src={iconUrls[0]} alt={title} className="w-full h-full object-cover" />
          ) : icon ? (
            <img src={icon} alt={title} className="w-full h-full object-cover" />
          ) : defaultIcon ? (
            <img src={defaultIcon} alt={title} className="w-full h-full object-cover" />
          ) : null}
        </div>
      )}
      <div>
        <h3 className="font-semibold text-zinc-800">{title}</h3>
        {subtitle && <p className="text-sm text-zinc-500 mt-0.5">{subtitle}</p>}
        {description && <p className="text-sm text-zinc-600 mt-1">{description}</p>}
      </div>
      {actionText && onAction && !disabled && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          className="mt-3 w-full rounded-md bg-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors"
        >
          {actionText}
        </button>
      )}
    </div>
  );
}