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

export default CreatorMarker;
