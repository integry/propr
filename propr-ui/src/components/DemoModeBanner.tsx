import React from 'react';
import { Info } from 'lucide-react';
import { useDemoMode } from '../contexts/DemoModeContext';

const DemoModeBanner: React.FC = () => {
  const { isDemoMode } = useDemoMode();

  if (!isDemoMode) return null;

  return (
    <div className="flex h-9 flex-shrink-0 items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-3 text-xs font-medium text-amber-900 sm:text-sm">
      <Info className="h-4 w-4 flex-shrink-0" />
      <span className="truncate">
        Demo mode: read-only access is enabled. GitHub mutations and AI execution are disabled.
      </span>
    </div>
  );
};

export default DemoModeBanner;
