export function BoardSkeleton() {
  return (
    <div className="h-screen bg-zinc-100 dark:bg-zinc-900 p-6">
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
                  className="animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-700 p-3"
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
      <div className="flex flex-col items-center gap-3 rounded-xl bg-white dark:bg-zinc-700 px-6 py-4 shadow-lg">
        <Spinner className="h-8 w-8 text-blue-500" />
        <span className="text-sm text-zinc-600 dark:text-zinc-300">{message}</span>
      </div>
    </div>
  );
}

export function TaskModalSkeleton() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/70 overflow-y-auto"
      data-testid="task-modal-skeleton"
    >
      <div className="relative z-10 flex flex-col bg-white dark:bg-zinc-800 rounded-xl shadow-xl overflow-hidden h-full max-h-[calc(100vh-4rem)] my-8 mx-auto max-w-7xl w-full">
        {/* Header skeleton */}
        <div className="flex-shrink-0 flex items-center justify-between border-b border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="h-7 w-20 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700" />
            <div className="space-y-2">
              <div className="h-6 w-64 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="h-3 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-9 w-20 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-9 w-9 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-9 w-9 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Main content skeleton - left side */}
          <div className="flex-1 min-w-[28rem] overflow-y-auto p-6 space-y-6">
            {/* Description block */}
            <div>
              <div className="mb-2 h-4 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="space-y-2 rounded-lg bg-zinc-50 dark:bg-zinc-700/50 p-4">
                <div className="h-3 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-600" />
                <div className="h-3 w-11/12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-600" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-600" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-600" />
              </div>
            </div>

            {/* Meta block */}
            <div>
              <div className="mb-2 h-4 w-12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="space-y-2">
                <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-4 w-1/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              </div>
            </div>

            {/* Subtasks block */}
            <div>
              <div className="mb-3 h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="space-y-2">
                <div className="h-5 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-5 w-2/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              </div>
            </div>

            {/* Attachments block */}
            <div>
              <div className="mb-3 h-4 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="h-16 w-full animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-700" />
            </div>
          </div>

          {/* Comments sidebar skeleton - right side */}
          <div className="w-1/3 min-w-80 border-l border-zinc-100 dark:border-zinc-700 flex flex-col">
            <div className="flex-shrink-0 p-4 pb-2 border-b border-zinc-100 dark:border-zinc-700 flex items-center justify-between">
              <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="rounded-lg bg-zinc-50 dark:bg-zinc-700/50 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-600" />
                    <div className="h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-600" />
                    <div className="ml-auto h-3 w-12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-600" />
                  </div>
                  <div className="h-3 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-600" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-zinc-200 dark:bg-zinc-600" />
                </div>
              ))}
            </div>
            <div className="flex-shrink-0 p-4 border-t border-zinc-100 dark:border-zinc-700 space-y-2">
              <div className="h-20 w-full animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-700" />
              <div className="h-9 w-full animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
            </div>
          </div>
        </div>

        {/* Footer skeleton */}
        <div className="flex-shrink-0 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <div className="flex gap-3">
            <div className="h-4 w-12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-4 w-12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          </div>
        </div>
      </div>
    </div>
  );
}
