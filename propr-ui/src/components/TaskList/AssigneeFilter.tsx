import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Users } from 'lucide-react';
import { MAX_TASK_ASSIGNMENT_FILTER_LOGINS, isGitHubLogin, parseTaskAssignmentFilter } from '@propr/shared';
import { assigneeParamFor } from './utils';

const loginKey = (login: string) => login.toLowerCase();

/** Logins in first-seen order, without case-insensitive repeats. */
const uniqueLogins = (logins: readonly string[]): string[] => [...new Map(logins.map(login => [loginKey(login), login])).values()];

type Mode = 'all' | 'me' | 'unassigned';

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'all', label: 'All assignees' },
  { value: 'me', label: 'Assigned to me' },
  { value: 'unassigned', label: 'Unassigned' },
];

interface Selection {
  mode: Mode | 'users' | 'invalid';
  logins: string[];
}

const readSelection = (value: string): Selection => {
  const parsed = parseTaskAssignmentFilter(value);
  if (!parsed.ok) return { mode: 'invalid', logins: [] };
  return parsed.filter.mode === 'users' ? { mode: 'users', logins: parsed.filter.logins } : { mode: parsed.filter.mode, logins: [] };
};

/** What the trigger reads as: a mode, one login, or the first login and how many more. */
const describeSelection = (selection: Selection, raw: string): string => {
  if (selection.mode === 'invalid') return raw;
  if (selection.mode !== 'users') return MODES.find(mode => mode.value === selection.mode)!.label;
  const [first, ...rest] = selection.logins;
  return rest.length ? `@${first} +${rest.length}` : `@${first}`;
};

interface PopoverProps {
  id: string;
  selection: Selection;
  people: string[];
  showMe: boolean;
  onMode: (mode: Mode) => void;
  onLogins: (logins: string[]) => void;
}

/**
 * Everyone, me or nobody as single choices, then any number of people. A
 * person who is on no page seen yet can be typed in: the field filters the
 * list, and a valid login it does not hold is offered to add.
 */
const AssigneePopover: React.FC<PopoverProps> = ({ id, selection, people, showMe, onMode, onLogins }) => {
  const queryRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [invalid, setInvalid] = useState(false);
  // Logins typed in, or selected when the popover opened, stay listed until it closes,
  // so unticking one does not make it vanish from under the pointer.
  const [extras, setExtras] = useState<string[]>(() => selection.logins);

  useEffect(() => { queryRef.current?.focus(); }, []);

  const selected = new Set(selection.logins.map(loginKey));
  const rows = uniqueLogins([...people, ...extras, ...selection.logins]);
  const typed = query.trim().replace(/^@/, '');
  const visible = typed ? rows.filter(login => login.toLowerCase().includes(typed.toLowerCase())) : rows;
  const exact = rows.find(login => loginKey(login) === loginKey(typed));
  const atLimit = selection.logins.length >= MAX_TASK_ASSIGNMENT_FILTER_LOGINS;
  const canAdd = Boolean(typed) && !exact && isGitHubLogin(typed) && !atLimit;

  const toggle = (login: string) => onLogins(selected.has(loginKey(login))
    ? selection.logins.filter(current => loginKey(current) !== loginKey(login))
    : [...selection.logins, login]);

  const add = () => {
    if (exact) {
      if (!selected.has(loginKey(exact)) && !atLimit) toggle(exact);
    } else if (canAdd) {
      setExtras(current => [...current, typed]);
      onLogins([...selection.logins, typed]);
    } else {
      // At the limit a valid login is simply not added; the footer says why.
      if (typed && !isGitHubLogin(typed)) setInvalid(true);
      return;
    }
    setQuery('');
    queryRef.current?.focus();
  };

  return (
    <div
      id={id}
      role="dialog"
      aria-label="Filter by assignee"
      data-testid="task-assignee-filter-popover"
      className="absolute right-0 top-full z-50 mt-1 flex w-64 max-w-[calc(100vw-1rem)] flex-col rounded-md border border-gray-200 bg-white text-sm shadow-lg"
    >
      <div role="radiogroup" aria-label="Show" className="border-b border-gray-100 p-1">
        {MODES.filter(mode => mode.value !== 'me' || showMe).map(mode => (
          <label key={mode.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-gray-700 hover:bg-gray-50 has-[:focus-visible]:bg-gray-50">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={selection.mode === mode.value}
              onChange={() => onMode(mode.value)}
              className="h-3.5 w-3.5 flex-none border-gray-300 text-teal-600 focus:ring-teal-500"
            />
            {mode.label}
          </label>
        ))}
      </div>
      <div className="border-b border-gray-100 p-2">
        <input
          ref={queryRef}
          type="search"
          value={query}
          onChange={event => { setQuery(event.target.value); setInvalid(false); }}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); add(); }
          }}
          placeholder="Find or add a GitHub login"
          aria-label="Find or add a GitHub login"
          aria-invalid={invalid || undefined}
          className="w-full rounded border border-gray-200 px-2 py-1 text-sm text-gray-700 placeholder:text-gray-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
        />
        {invalid && <p role="alert" className="mt-1 text-xs text-red-600">@{typed} is not a valid GitHub login.</p>}
      </div>
      <div role="group" aria-label="People" className="max-h-60 overflow-y-auto p-1">
        {visible.map(login => {
          const checked = selected.has(loginKey(login));
          return (
            <label
              key={loginKey(login)}
              data-testid="task-assignee-filter-person"
              className={`flex min-w-0 items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50 has-[:focus-visible]:bg-gray-50 ${!checked && atLimit ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && atLimit}
                onChange={() => toggle(login)}
                className="h-3.5 w-3.5 flex-none rounded border-gray-300 text-teal-600 focus:ring-teal-500"
              />
              <span className="truncate font-mono text-gray-700">@{login}</span>
            </label>
          );
        })}
        {canAdd && (
          <button
            type="button"
            onClick={add}
            className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-teal-700 hover:bg-teal-50"
          >
            <span className="truncate">Add <span className="font-mono">@{typed}</span></span>
          </button>
        )}
        {visible.length === 0 && !canAdd && (
          <p className="px-2 py-1.5 text-gray-500">{typed ? 'No one matches.' : 'Type a login to filter by someone.'}</p>
        )}
      </div>
      {atLimit && (
        <p className="border-t border-gray-100 px-3 py-1.5 text-xs text-gray-500">
          The filter can name at most {MAX_TASK_ASSIGNMENT_FILTER_LOGINS} people.
        </p>
      )}
    </div>
  );
};

interface AssigneeFilterProps {
  /** The `?assignee=` value: `all`, `me`, `unassigned`, or comma-separated logins. */
  assigneeFilter: string;
  setAssigneeFilter: (assignee: string) => void;
  /** Logins the filter lists before anything is typed. */
  people: string[];
  /** Whether a user is signed in, so `Assigned to me` has someone to mean. */
  canFilterToMe: boolean;
  className?: string;
  /** Phone sizing, matching the search field beside it: a 16px font and a 40px target. */
  touch?: boolean;
}

/**
 * Whose tasks the list shows: everyone's, the signed-in user's, nobody's, or
 * those of any number of people. The trigger names what applies, including a
 * value from the URL the list does not hold. In a toolbar too narrow for it,
 * the trigger collapses to an icon, beside the repository picker collapsed the
 * same way (see `task-queue.css`).
 */
export const AssigneeFilter: React.FC<AssigneeFilterProps> = ({
  assigneeFilter,
  setAssigneeFilter,
  people,
  canFilterToMe,
  className = '',
  touch = false,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const selection = readSelection(assigneeFilter);
  const label = describeSelection(selection, assigneeFilter);
  // `?assignee=me` from the URL keeps its own choice even when nobody is signed in to mean.
  const showMe = canFilterToMe || selection.mode === 'me';
  const active = selection.mode !== 'all';

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <span
      ref={containerRef}
      className={`task-assignee-filter relative flex ${className}`}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="task-assignee-filter"
        aria-label={`Assignee: ${label}`}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen(value => !value)}
        className={`flex min-w-0 flex-1 items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-2 text-sm text-gray-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500 sm:px-3${touch ? ' h-10 text-base' : ''}`}
      >
        <Users aria-hidden="true" className={`task-assignee-filter-icon h-4 w-4 flex-none ${active ? 'text-teal-600' : 'text-gray-500'}`} />
        <span className="task-assignee-filter-label min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDown aria-hidden="true" className="task-assignee-filter-chevron h-4 w-4 flex-none text-gray-500" />
      </button>
      {open && (
        <AssigneePopover
          id={popoverId}
          selection={selection}
          people={people}
          showMe={showMe}
          onMode={mode => { setAssigneeFilter(mode); close(); }}
          onLogins={logins => setAssigneeFilter(assigneeParamFor(logins))}
        />
      )}
    </span>
  );
};
