import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MoreHorizontal, Trash2 } from 'lucide-react';
import { getDeleteState, type DeletionProps, type OverflowMenuItem } from './taskActions';

const sheetRowClass = 'flex min-h-12 w-full items-center gap-3 px-5 text-left text-[15px] font-medium transition-colors focus:outline-none focus-visible:bg-slate-100';
const SHEET_FOCUSABLE = 'button:not(:disabled)';

/**
 * The collapsed mobile header's overflow: a sheet that rises from the bottom
 * of the screen instead of a popover over the page. Every row spans the width
 * and is at least 48px tall, Delete reads red, and Cancel closes it from a
 * separate card below the actions.
 */
const TaskActionSheet: React.FC<{
  items: OverflowMenuItem[];
  deletion?: DeletionProps;
}> = ({ items, deletion }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const deleteState = deletion && getDeleteState(deletion.isActive, deletion.stopFailed, deletion.deletingTask);

  useEffect(() => {
    if (open) sheetRef.current?.querySelector<HTMLButtonElement>(SHEET_FOCUSABLE)?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const select = (action: () => void) => () => {
    close();
    action();
  };
  // Keep Tab inside the sheet while it covers the page.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLButtonElement>(SHEET_FOCUSABLE) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="More task actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="-mr-2 flex h-11 w-11 flex-none items-center justify-center rounded-full text-slate-500 transition-colors active:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal size={20} />
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-50" onKeyDown={onKeyDown}>
          <div
            data-testid="task-action-sheet-scrim"
            aria-hidden="true"
            className="absolute inset-0 bg-slate-900/40 animate-fade-in motion-reduce:animate-none"
            onClick={close}
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Task actions"
            className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] animate-sheet-up motion-reduce:animate-none"
          >
            <div id={menuId} role="menu" aria-label="More task actions" className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-2xl">
              {items.map(item => (
                <button key={item.label} type="button" role="menuitem" title={item.title} className={`${sheetRowClass} text-slate-800 active:bg-slate-100`} onClick={select(item.onSelect)}>
                  <span className="text-slate-500">{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              ))}
              {deletion && deleteState && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={deleteState.isDisabled}
                  title={deleteState.title}
                  className={`${sheetRowClass} ${deleteState.isDisabled ? 'cursor-not-allowed text-slate-400' : 'text-red-600 active:bg-red-50'}`}
                  onClick={select(deletion.onDeleteTask)}
                >
                  {deletion.deletingTask ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                  <span>Delete</span>
                </button>
              )}
            </div>
            {/* Cancel is its own card, 8px below Delete, so a thumb reaching to dismiss can't land on Delete. */}
            <button
              type="button"
              className={`${sheetRowClass} justify-center rounded-2xl bg-white font-semibold text-slate-700 shadow-2xl active:bg-slate-100`}
              onClick={close}
            >
              Cancel
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default TaskActionSheet;
