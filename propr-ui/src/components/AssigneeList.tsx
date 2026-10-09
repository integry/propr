import type { AttributedUser } from '@propr/shared';
import UserAvatar from './UserAvatar';

/**
 * The one avatar + `@login` treatment for assigned users, kept as quiet as
 * GitHub's: no pill backgrounds or borders, a monospace slate login beside a
 * small round avatar. Every surface that shows assignees renders it from here
 * so the avatar sizes and spacing stay identical everywhere.
 */

export type AssigneeVariant = 'compact' | 'default' | 'prominent';

interface VariantStyle {
  avatar: string;
  login: string;
  gap: string;
  /** The most chips `AssigneeList` renders before the `+N` marker. */
  limit: number;
}

const VARIANTS: Record<AssigneeVariant, VariantStyle> = {
  // Dense rows: the login gives way to the avatar below `sm`.
  compact: { avatar: 'h-3.5 w-3.5 text-[.4rem]', login: 'hidden sm:inline', gap: 'gap-1', limit: 2 },
  default: { avatar: 'h-[18px] w-[18px] text-[.45rem]', login: 'inline', gap: 'gap-1.5', limit: 3 },
  // The task detail header.
  prominent: { avatar: 'h-6 w-6 text-[.55rem]', login: 'inline', gap: 'gap-1.5', limit: 5 },
};

/** The most avatars `AssigneeStack` overlaps before the `+N` marker. */
export const ASSIGNEE_STACK_LIMIT = 3;

const AVATAR_BASE = 'flex flex-none items-center justify-center rounded-full object-cover font-bold';
const AVATAR_FALLBACK = 'bg-slate-100 text-slate-600';
const LOGIN_TEXT = 'truncate font-mono text-xs text-slate-600';

const atLogins = (users: AttributedUser[]): string => users.map(user => `@${user.login}`).join(', ');

const assigneeAccessibleName = (user: AttributedUser): string => `Assigned to @${user.login}`;

const AssigneeAvatar = ({ user, className }: { user: AttributedUser; className: string }) => (
  <UserAvatar
    user={{ id: user.id, username: user.login, displayName: user.displayName ?? user.login, avatarUrl: user.avatarUrl }}
    className={`${AVATAR_BASE} ${className}`}
    fallbackClassName={AVATAR_FALLBACK}
    // The login is text beside or around the avatar, so the image adds nothing for assistive tech.
    decorative
    referrerPolicy="no-referrer"
  />
);

interface AssigneeChipProps {
  user: AttributedUser;
  variant?: AssigneeVariant;
  /** `listitem` inside an `AssigneeList`; a lone chip is a named `group`. */
  role?: 'listitem' | 'group';
}

/** One `avatar + @login` pair, named `Assigned to @login` whatever the viewport shows. */
export const AssigneeChip = ({ user, variant = 'default', role = 'group' }: AssigneeChipProps) => {
  const style = VARIANTS[variant];
  const name = assigneeAccessibleName(user);
  return (
    <span
      role={role}
      aria-label={name}
      title={user.displayName ? `${name} (${user.displayName})` : name}
      data-testid="assignee-chip"
      className={`inline-flex min-w-0 items-center ${style.gap}`}
    >
      <AssigneeAvatar user={user} className={style.avatar} />
      <span aria-hidden="true" className={`${LOGIN_TEXT} ${style.login}`}>@{user.login}</span>
    </span>
  );
};

/** The quiet placeholder for nobody assigned; it keeps a table column aligned. */
export const UnassignedMarker = ({ className = '' }: { className?: string }) => (
  <span data-testid="assignee-unassigned" title="Unassigned" className={`text-xs text-slate-400 ${className}`.trim()}>
    <span aria-hidden="true">—</span>
    <span className="sr-only">Unassigned</span>
  </span>
);

/** `+N`, naming the users it stands for in its tooltip and accessible name. */
const OverflowMarker = ({ hidden, className = '' }: { hidden: AttributedUser[]; className?: string }) => (
  <span
    role="listitem"
    aria-label={`${hidden.length} more ${hidden.length === 1 ? 'assignee' : 'assignees'}: ${atLogins(hidden)}`}
    title={atLogins(hidden)}
    data-testid="assignee-overflow"
    className={`font-mono text-xs text-slate-500 ${className}`.trim()}
  >
    <span aria-hidden="true">+{hidden.length}</span>
  </span>
);

interface AssigneeListProps {
  assignees: AttributedUser[] | null | undefined;
  variant?: AssigneeVariant;
  /** Overrides the variant's chip limit. */
  max?: number;
  className?: string;
}

/** A bounded row of chips with a `+N` overflow marker; the row's tooltip names everyone. */
export const AssigneeList = ({ assignees, variant = 'default', max, className = '' }: AssigneeListProps) => {
  if (!assignees || assignees.length === 0) return <UnassignedMarker className={className} />;
  const limit = Math.max(1, max ?? VARIANTS[variant].limit);
  const visible = assignees.slice(0, limit);
  const hidden = assignees.slice(limit);
  return (
    <span
      role="list"
      aria-label="Assignees"
      title={`Assigned to ${atLogins(assignees)}`}
      className={`inline-flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 ${className}`.trim()}
    >
      {visible.map(user => <AssigneeChip key={user.id} user={user} variant={variant} role="listitem" />)}
      {hidden.length > 0 && <OverflowMarker hidden={hidden} />}
    </span>
  );
};

interface AssigneeStackProps {
  assignees: AttributedUser[] | null | undefined;
  variant?: AssigneeVariant;
  /** Overrides `ASSIGNEE_STACK_LIMIT`. */
  max?: number;
  className?: string;
}

/** Avatars only, overlapped, for dense table cells; each avatar keeps its `Assigned to @login` name. */
export const AssigneeStack = ({ assignees, variant = 'compact', max, className = '' }: AssigneeStackProps) => {
  if (!assignees || assignees.length === 0) return <UnassignedMarker className={className} />;
  const limit = Math.max(1, max ?? ASSIGNEE_STACK_LIMIT);
  const visible = assignees.slice(0, limit);
  const hidden = assignees.slice(limit);
  return (
    <span
      role="list"
      aria-label="Assignees"
      title={`Assigned to ${atLogins(assignees)}`}
      className={`inline-flex items-center ${className}`.trim()}
    >
      {visible.map((user, index) => (
        <span
          key={user.id}
          role="listitem"
          aria-label={assigneeAccessibleName(user)}
          data-testid="assignee-stack-avatar"
          // Overlap the avatars; the white ring separates them without a border.
          className={`flex rounded-full ring-1 ring-white ${index > 0 ? '-ml-1' : ''}`}
        >
          <AssigneeAvatar user={user} className={VARIANTS[variant].avatar} />
        </span>
      ))}
      {hidden.length > 0 && <OverflowMarker hidden={hidden} className="ml-1" />}
    </span>
  );
};

export default AssigneeList;
