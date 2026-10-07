import React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Settings2 } from 'lucide-react';
import { useAnchoredPopover } from './useAnchoredPopover';

interface ExecutionConfigPopoverProps {
  summary: string;
  children: React.ReactNode;
}

/**
 * The execution settings behind a single summary button, so the default agent,
 * auto-merge and ultrafix controls do not stack up as rows above the issue table.
 */
export const ExecutionConfigPopover: React.FC<ExecutionConfigPopoverProps> = ({ summary, children }) => {
  // Portalled with fixed, viewport-aware coordinates so neither the surrounding layout nor a
  // short viewport can clip it.
  const { open, position, toggle, containerRef, popoverRef } = useAnchoredPopover();

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Execution config"
        className="inline-flex max-w-full items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs sm:text-sm text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
        data-testid="execution-config-button"
      >
        <Settings2 size={14} className="flex-shrink-0 text-slate-500" />
        {/* The settings icon stands in for the label on phones, leaving the room to the summary. */}
        <span className="font-medium flex-shrink-0 sr-only sm:not-sr-only">Config:</span>
        <span className="truncate text-slate-600">{summary}</span>
        <ChevronDown size={14} className={`flex-shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {position && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Execution config"
          style={position}
          className="fixed z-50 w-max max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-slate-200 bg-white p-3 shadow-lg"
        >
          {children}
        </div>,
        document.body
      )}
    </div>
  );
};
