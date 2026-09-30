import { Button } from "@/components/ui/Button";

export function ErrorAlert({
  message,
  onDismiss,
  onRetry,
}: {
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
    >
      <p className="min-w-0 flex-1">{message}</p>
      {onRetry && (
        <Button onClick={onRetry} className="!py-1">
          Retry
        </Button>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss error"
          onClick={onDismiss}
          className="rounded px-1 leading-none hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-black dark:hover:bg-red-900/50 dark:focus-visible:outline-white"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}
