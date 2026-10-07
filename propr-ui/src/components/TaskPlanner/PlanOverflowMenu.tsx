import React, { useState } from 'react';
import { Loader2, MoreHorizontal, Trash2 } from 'lucide-react';

export interface PlanMenuItem {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
}

interface PlanOverflowMenuProps {
  isDeleting: boolean;
  deleteDisabled: boolean;
  deleteTitle: string;
  onDelete: () => void;
  /** Non-destructive actions listed above Delete, e.g. Pause and Revise in the phone header. */
  items?: PlanMenuItem[];
}

/** Destructive plan actions live behind "…" so they are never one stray click away. */
export const PlanOverflowMenu: React.FC<PlanOverflowMenuProps> = ({ isDeleting, deleteDisabled, deleteTitle, onDelete, items = [] }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="More plan actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="More plan actions"
        className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200 rounded-md transition-colors"
      >
        {isDeleting ? <Loader2 size={16} className="animate-spin" /> : <MoreHorizontal size={16} />}
      </button>
      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-44 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => { setIsOpen(false); item.onSelect(); }}
                disabled={item.disabled}
                title={item.title}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {item.icon}
                {item.label}
              </button>
            ))}
            {/* A rule sets Delete apart from the everyday actions above it. */}
            {items.length > 0 && <div role="separator" className="my-1 border-t border-slate-100" />}
            <button
              type="button"
              role="menuitem"
              onClick={() => { setIsOpen(false); onDelete(); }}
              disabled={deleteDisabled}
              title={deleteTitle}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 size={14} />
              Delete plan
            </button>
          </div>
        </>
      )}
    </div>
  );
};
