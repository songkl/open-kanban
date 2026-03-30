export function BoardSkeleton() {
  return (
    <div className="h-screen bg-zinc-100 p-6">
      {/* Header skeleton */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="h-8 w-24 animate-pulse rounded bg-zinc-300" />
          <div className="h-9 w-40 animate-pulse rounded-md bg-zinc-300" />
        </div>
        <div className="flex items-center gap-4">
          <div className="h-9 w-20 animate-pulse rounded-md bg-zinc-300" />
          <div className="h-9 w-20 animate-pulse rounded-md bg-zinc-300" />
          <div className="h-9 w-20 animate-pulse rounded-md bg-zinc-300" />
          <div className="h-9 w-24 animate-pulse rounded-md bg-zinc-300" />
        </div>
      </div>

      {/* Columns skeleton */}
      <div className="flex h-[calc(100vh-120px)] gap-4 overflow-x-auto pb-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex w-80 flex-shrink-0 flex-col rounded-lg bg-zinc-200/50"
          >
            {/* Column header */}
            <div className="flex items-center gap-2 rounded-t-lg px-4 py-3">
              <div className="h-3 w-3 animate-pulse rounded-full bg-zinc-300" />
              <div className="h-5 w-24 animate-pulse rounded bg-zinc-300" />
              <div className="ml-auto h-5 w-8 animate-pulse rounded bg-zinc-300" />
            </div>

            {/* Task cards skeleton */}
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {Array.from({ length: 3 + (index % 2) }).map((_, taskIndex) => (
                <div
                  key={taskIndex}
                  className="animate-pulse rounded-lg bg-zinc-100 p-3"
                >
                  <div className="mb-2 h-5 w-full animate-pulse rounded bg-zinc-300" />
                  <div className="mb-3 h-4 w-3/4 animate-pulse rounded bg-zinc-300" />
                  <div className="flex items-center justify-between">
                    <div className="h-4 w-16 animate-pulse rounded bg-zinc-300" />
                    <div className="h-6 w-6 animate-pulse rounded-full bg-zinc-300" />
                  </div>
                </div>
              ))}
            </div>

            {/* Add task button skeleton */}
            <div className="p-2">
              <div className="h-9 w-full animate-pulse rounded-md bg-zinc-300" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div
      className={`inline-block animate-spin rounded-full border-2 border-solid border-current border-r-transparent ${className}`}
      role="status"
    >
      <span className="sr-only">Loading...</span>
    </div>
  );
}

export function LoadingOverlay({ message }: { message?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/10 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl bg-white px-6 py-4 shadow-lg">
        <Spinner className="h-8 w-8 text-blue-500" />
        <span className="text-sm text-zinc-600">{message}</span>
      </div>
    </div>
  );
}
