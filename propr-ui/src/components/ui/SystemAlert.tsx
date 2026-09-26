import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface SystemAlertProps {
  children: ReactNode;
  variant?: 'error' | 'empty';
  icon?: ReactNode;
  onRetry?: () => void;
}

export const SystemAlert: React.FC<SystemAlertProps> = ({
  children,
  variant = 'error',
  icon,
  onRetry,
}) => {
  if (variant === 'empty') {
    return (
      <div role="status" className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-sm text-slate-400">
        {icon}
        <span>{children}</span>
      </div>
    );
  }

  return (
    <div role="alert" className="flex w-full self-start items-start gap-3 rounded-md border border-red-100 bg-red-50 p-4 text-sm font-medium text-red-700">
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-none" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex-none rounded border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1"
        >
          Retry
        </button>
      )}
    </div>
  );
};
