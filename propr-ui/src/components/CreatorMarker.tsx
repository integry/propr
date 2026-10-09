/* eslint-disable react-refresh/only-export-components */
import { useMemo } from 'react';
import type { AttributedUser } from '@propr/shared';
import { AssigneeChip, type AssigneeVariant } from './AssigneeList';

/**
 * Who created a plan, goal, automation or to-do. The creator is secondary
 * information - it answers "whose is this" while scanning - so it reuses the
 * quiet assignee treatment and sits on a row's existing metadata line, never in
 * a column of its own.
 */

interface CreatorMarkerProps {
  creator: AttributedUser | null | undefined;
  variant?: AssigneeVariant;
  /** Avatar only, for rows with no room for the login; the login stays in the tooltip and accessible name. */
  avatarOnly?: boolean;
  /** Align on the login's text baseline, for metadata lines that align on baselines. */
  baseline?: boolean;
}

/** `avatar + @login`, named `Created by @login`; an unknown creator renders nothing, so it leaves no gap. */
export const CreatorMarker = ({ creator, variant = 'compact', avatarOnly = false, baseline = false }: CreatorMarkerProps) => {
  if (!creator) return null;
  return (
    <AssigneeChip
      user={creator}
      variant={variant}
      relation="Created by"
      avatarOnly={avatarOnly}
      baseline={baseline}
      data-testid="creator-marker"
    />
  );
};

const defaultCreatorOf = (item: { createdBy?: AttributedUser | null }) => item.createdBy;

/**
 * Whether the creator is worth showing for a list: on a single-developer
 * instance every row shares one creator, and repeating it everywhere is noise.
 * `show` is false for zero or one distinct creator; items with no known creator
 * do not count as a creator of their own.
 */
export function useDistinctCreators<T>(
  items: readonly T[],
  creatorOf: (item: T) => AttributedUser | null | undefined = defaultCreatorOf as (item: T) => AttributedUser | null | undefined,
): { show: boolean; count: number } {
  return useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      const creator = creatorOf(item);
      if (creator) ids.add(creator.id);
    }
    return { show: ids.size > 1, count: ids.size };
  }, [items, creatorOf]);
}

export default CreatorMarker;
