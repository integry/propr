import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Settings2 } from 'lucide-react';

interface ExecutionConfigPopoverProps {
  summary: string;
  children: React.ReactNode;
}

/**
 * The execution settings behind a single summary button, so the default agent,
 * auto-merge and ultrafix controls do not stack up as rows above the issue table.
 */
export const ExecutionConfigPopover: React.FC<ExecutionConfigPopoverProps> = ({ summary, children }) => {
  // Portalled with fixed coordinates so the surrounding layout cannot clip it.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const open = anchor !== null;
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const close = () => setAnchor(null);
  const toggle = () => {
    if (open) { close(); return; }
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    const handleScroll = (event: Event) => {
      if (!popoverRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [open]);

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
        <span className="font-medium flex-shrink-0">Config:</span>
        <span className="truncate text-slate-600">{summary}</span>
        <ChevronDown size={14} className={`flex-shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {anchor && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Execution config"
          style={{ top: anchor.top, right: anchor.right }}
          className="fixed z-50 w-max max-w-[calc(100vw-1rem)] rounded-md border border-slate-200 bg-white p-3 shadow-lg"
        >
          {children}
        </div>,
        document.body
      )}
    </div>
  );
};
