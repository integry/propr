import React, { useEffect, useState } from 'react';
import { ChevronDown, List, X } from 'lucide-react';
import { getOutlineTitle } from './planDisplayName';

interface MobileTaskJumperProps {
  taskTitles: string[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

/**
 * Phone stand-in for the desktop outline rail: a compact "Task 3 of 17" bar pinned above the
 * specification that opens a bottom sheet of every task title, so a long plan never has to be
 * scrolled end to end to reach a late task.
 */
export const MobileTaskJumper: React.FC<MobileTaskJumperProps> = ({ taskTitles, activeIndex, onSelect }) => {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  return (
    <>
      <div className="flex-shrink-0 border-b border-slate-200 bg-white px-3 py-1.5">
        <button
          type="button"
          data-testid="mobile-task-jumper"
          onClick={() => setIsOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          className="flex w-full min-w-0 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <List size={15} className="flex-shrink-0 text-slate-500" />
          <span className="flex-shrink-0 font-medium text-slate-900">Task {activeIndex + 1} of {taskTitles.length}</span>
          <span className="min-w-0 flex-1 truncate text-slate-500">{getOutlineTitle(taskTitles[activeIndex] ?? '')}</span>
          <ChevronDown size={15} className="flex-shrink-0 text-slate-500" />
        </button>
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setIsOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Jump to task"
            className="relative flex max-h-[75vh] flex-col rounded-t-xl bg-white pb-[env(safe-area-inset-bottom)] shadow-xl"
          >
            <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Jump to task</h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Close"
                className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <ol className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
              {taskTitles.map((title, index) => {
                const isActive = index === activeIndex;
                return (
                  <li key={index}>
                    <button
                      type="button"
                      onClick={() => { setIsOpen(false); onSelect(index); }}
                      aria-current={isActive ? 'step' : undefined}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left text-sm transition-colors ${
                        isActive ? 'bg-teal-50 text-teal-900' : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className={`w-6 flex-shrink-0 text-right font-mono text-xs leading-5 ${isActive ? 'text-teal-700' : 'text-slate-400'}`}>
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 leading-5">{getOutlineTitle(title)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
    </>
  );
};
