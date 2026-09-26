import React from 'react';

/**
 * Monospace "code chip" for technical entities (repository handles, opaque ids),
 * mirroring `ReferenceChip` from the task list. Long values truncate inside the
 * chip; pass `title` (defaults to string children) so the full value stays reachable.
 */
export const CodeChip: React.FC<{ children: React.ReactNode; title?: string; className?: string }> = ({ children, title, className = '' }) => (
  <span
    className={`inline-block max-w-full truncate align-middle font-mono text-[12px] leading-4 bg-slate-100 border border-slate-200 text-slate-800 rounded-sm px-1.5 py-0.5 ${className}`.trim()}
    title={title ?? (typeof children === 'string' ? children : undefined)}
  >
    {children}
  </span>
);

/** Uppercase badge for permission scopes and other short enumerated labels. */
export const ScopeBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex items-center uppercase text-[10px] font-bold leading-4 tracking-wide text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded">
    {children}
  </span>
);
