import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { MAX_TASK_ASSIGNEES, type AttributedUser } from '@propr/shared';
import { AssigneeList } from '../AssigneeList';
import UserAvatar from '../UserAvatar';
import type { TaskAssignment } from './useTaskAssignment';

/** Keeps the popover this far inside the viewport's edges. */
const VIEWPORT_MARGIN = 8;

const FOCUSABLE = 'input:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

const sameLogins = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every(login => b.has(login));

const loginKey = (login: string) => login.toLowerCase();

const UserOption: React.FC<{
  user: AttributedUser;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}> = ({ user, checked, disabled, onToggle, onKeyDown }) => (
  <label
    data-testid="assignment-option"
    className={`flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-slate-50 has-[:focus-visible]:bg-slate-50 ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
      onKeyDown={onKeyDown}
      data-assignment-option=""
      className="h-3.5 w-3.5 flex-none rounded border-slate-300 text-teal-600 focus:ring-teal-500"
    />
    <UserAvatar
      user={{ id: user.id, username: user.login, displayName: user.displayName ?? user.login, avatarUrl: user.avatarUrl }}
      className="flex h-5 w-5 flex-none items-center justify-center rounded-full object-cover text-[.5rem] font-bold"
      fallbackClassName="bg-slate-100 text-slate-600"
      decorative
      referrerPolicy="no-referrer"
    />
    <span className="truncate font-mono text-slate-700">@{user.login}</span>
    {user.displayName && user.displayName !== user.login && (
      <span className="min-w-0 truncate text-slate-400">{user.displayName}</span>
    )}
  </label>
);

interface EditorProps {
  id: string;
  assignment: TaskAssignment;
  onClose: (restoreFocus: boolean) => void;
}

/** The popover: a filterable checkbox list of assignable users, the current assignees pre-checked. */
const AssignmentEditor: React.FC<EditorProps> = ({ id, assignment, onClose }) => {
  const { assignees, assignable, loadAssignableUsers, save, saving } = assignment;
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [initial] = useState(() => new Set(assignees.map(user => loginKey(user.login))));
  const [selected, setSelected] = useState<Set<string>>(initial);
  const [filter, setFilter] = useState('');
  const [shift, setShift] = useState(0);

  useEffect(() => {
    loadAssignableUsers();
    filterRef.current?.focus();
  }, [loadAssignableUsers]);

  // A trigger near the right edge would push the popover off a phone's screen.
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const overflowRight = rect.right - (window.innerWidth - VIEWPORT_MARGIN);
    if (overflowRight > 0) setShift(-Math.min(overflowRight, Math.max(0, rect.left - VIEWPORT_MARGIN)));
  }, []);

  // The current assignees lead, as on GitHub, including any it no longer lists as assignable
  // so they can still be unassigned. The order is fixed on open, so rows don't jump when toggled.
  const users = useMemo(() => {
    const listed = assignable.users ?? [];
    const listedLogins = new Set(listed.map(user => loginKey(user.login)));
    return [
      ...assignees.filter(user => !listedLogins.has(loginKey(user.login))),
      ...listed.filter(user => initial.has(loginKey(user.login))),
      ...listed.filter(user => !initial.has(loginKey(user.login))),
    ];
  }, [assignable.users, assignees, initial]);
  const query = filter.trim().replace(/^@/, '').toLowerCase();
  const visible = query
    ? users.filter(user => user.login.toLowerCase().includes(query) || user.displayName?.toLowerCase().includes(query))
    : users;
  const atLimit = selected.size >= MAX_TASK_ASSIGNEES;
  const changed = !sameLogins(selected, initial);

  const toggle = (login: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(loginKey(login))) next.delete(loginKey(login));
    else next.add(loginKey(login));
    return next;
  });

  const options = () => [...(ref.current?.querySelectorAll<HTMLInputElement>('[data-assignment-option]:not(:disabled)') ?? [])];
  const moveFocus = (from: HTMLInputElement | null, delta: number) => {
    const list = options();
    if (!list.length) return;
    const index = from ? list.indexOf(from) : -1;
    if (index + delta < 0) { filterRef.current?.focus(); return; }
    list[Math.min(list.length - 1, index + delta)]?.focus();
  };
  const onOptionKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const list = options();
      list[event.key === 'Home' ? 0 : list.length - 1]?.focus();
    }
  };

  const submit = () => {
    // Saves run one at a time, so an editor left open in the other layout waits for the first.
    if (saving) return;
    if (!changed) { onClose(true); return; }
    // Logins keep the casing GitHub gave them.
    const byKey = new Map(users.map(user => [loginKey(user.login), user.login]));
    const logins = [...selected].map(key => byKey.get(key) ?? key);
    onClose(true);
    void save(logins);
  };

  return (
    <div
      id={id}
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Assign users"
      data-testid="assignment-editor"
      style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      className="absolute left-0 top-full z-50 mt-1 flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded border border-slate-200 bg-white text-xs shadow-lg"
      onKeyDown={event => {
        // Tab cycles within the popover while it is open.
        if (event.key !== 'Tab') return;
        const focusable = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
    >
      <div className="border-b border-slate-100 p-2">
        <input
          ref={filterRef}
          type="search"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(null, 1); }
          }}
          placeholder="Filter users"
          aria-label="Filter users"
          className="w-full rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
        />
      </div>
      <div role="group" aria-label="Assignable users" className="max-h-60 overflow-y-auto p-1">
        {visible.map(user => {
          const checked = selected.has(loginKey(user.login));
          return (
            <UserOption
              key={user.id}
              user={user}
              checked={checked}
              disabled={!checked && atLimit}
              onToggle={() => toggle(user.login)}
              onKeyDown={onOptionKeyDown}
            />
          );
        })}
        {assignable.loading && <p role="status" className="px-2 py-1.5 text-slate-500">Loading users…</p>}
        {assignable.error && (
          <p role="alert" className="px-2 py-1.5 text-red-600">
            Couldn't load assignable users: {assignable.error}{' '}
            <button type="button" className="font-medium underline hover:text-red-700" onClick={loadAssignableUsers}>Retry</button>
          </p>
        )}
        {!assignable.loading && !assignable.error && visible.length === 0 && (
          <p className="px-2 py-1.5 text-slate-500">{query ? 'No users match.' : 'No assignable users.'}</p>
        )}
      </div>
      {(assignable.truncated || atLimit) && (
        <p className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
          {atLimit
            ? `GitHub allows at most ${MAX_TASK_ASSIGNEES} assignees.`
            : `Only the first ${assignable.users?.length ?? 0} assignable users are listed, and the filter searches only these. Assign anyone else on GitHub.`}
        </p>
      )}
      <div className="flex items-center gap-1.5 border-t border-slate-100 p-2">
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={() => setSelected(new Set())}
          className="rounded px-2 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Clear
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => onClose(true)}
          className="rounded px-2 py-1 font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!changed || saving}
          onClick={submit}
          className="rounded bg-teal-600 px-2.5 py-1 font-medium text-white hover:bg-teal-700 disabled:opacity-50 disabled:hover:bg-teal-600"
        >
          Save
        </button>
      </div>
    </div>
  );
};

/**
 * Who the task's issue or pull request is assigned to, beside the other Git
 * facts, with an editor for viewers who may change it. A task with nothing
 * to assign (a goal task) renders nothing at all.
 */
const AssignmentControl: React.FC<{ assignment: TaskAssignment }> = ({ assignment }) => {
  const { assignees, loading, error, unavailable, editable, saving } = assignment;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editorId = useId();

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  useEffect(() => {
    if (!editable) setOpen(false);
  }, [editable]);

  // Nothing until the first read answers, so a goal task never flashes an empty state.
  if (loading || unavailable || error) return null;

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="Assignment"
      aria-busy={saving || undefined}
      data-testid="task-assignment"
      className="relative inline-flex min-w-0 items-center gap-1.5"
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
    >
      {/* On a phone the control wraps to its own line, where a divider would dangle. */}
      <span aria-hidden="true" className="mr-0.5 hidden h-3 w-px flex-none bg-slate-200 sm:inline-block" />
      {assignees.length > 0
        ? <AssigneeList assignees={assignees} variant="prominent" />
        : <span data-testid="assignment-unassigned" className="text-xs text-slate-500">Unassigned</span>}
      {editable && (
        <button
          ref={triggerRef}
          type="button"
          aria-label={assignees.length ? 'Edit assignees' : 'Assign users'}
          title={assignees.length ? 'Edit assignees' : 'Assign users'}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? editorId : undefined}
          // Not `disabled`: Save hands focus back to this button just as the save starts.
          aria-disabled={saving || undefined}
          data-testid="assignment-trigger"
          onClick={() => { if (!saving) setOpen(value => !value); }}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 aria-disabled:cursor-wait aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-slate-500"
        >
          <UserPlus size={12} aria-hidden="true" />
          {assignees.length === 0 && <span>Assign</span>}
        </button>
      )}
      {open && editable && <AssignmentEditor id={editorId} assignment={assignment} onClose={close} />}
    </div>
  );
};

export default AssignmentControl;
