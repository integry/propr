import type { SyntheticModelMember } from '@propr/shared';
import { AgentCapacityError } from '../agents/agentCapacity.js';

export interface CapacityCandidate {
  member: SyntheticModelMember;
  headroom: number;
}

/**
 * Picks a member of the highest eligible priority tier. Capacity never moves
 * the choice to a lower tier and never counts as a failed attempt: a member
 * whose direct alias is at its per-agent ceiling is only skipped for another
 * member of the same tier with room. With no such member a deferrable
 * selection throws AgentCapacityError; otherwise the usual choice is kept and
 * waits at admission. A pinned member (an earlier pre-check's choice) is
 * reused without advancing the round-robin cursor.
 */
export async function chooseMemberWithCapacity<T extends CapacityCandidate>(options: {
  pinnedMemberId?: string;
  defersOnCapacity: boolean;
  strategy: string;
  eligible: T[];
  tier: T[];
  highestPriority: number;
  aliasCapacity: (directAgentAlias: string) => Promise<boolean>;
  nextCursor: () => Promise<number>;
}): Promise<{ chosen: T; selectionReason: string }> {
  const { eligible, tier, highestPriority } = options;
  const capacity = new Map<string, boolean>();
  const hasCapacity = async (item: T) => {
    const alias = item.member.directAgentAlias;
    if (!capacity.has(alias)) capacity.set(alias, await options.aliasCapacity(alias));
    return capacity.get(alias)!;
  };
  const refusal = (members: T[]) => new AgentCapacityError([...new Set(members.map(item => item.member.directAgentAlias))]);
  const pinned = options.pinnedMemberId ? eligible.find(item => item.member.id === options.pinnedMemberId) : undefined;
  const pinnedTier = pinned ? eligible.filter(item => item.member.priority === pinned.member.priority) : tier;
  const withRoom: T[] = [];
  for (const item of pinnedTier) if (await hasCapacity(item)) withRoom.push(item);
  if (pinned) {
    const reason = `pinned: member selected before deferral (priority ${pinned.member.priority})`;
    if (withRoom.includes(pinned)) return { chosen: pinned, selectionReason: reason };
    // Deterministic, so a re-entered job never advances the round-robin cursor.
    const alternative = [...withRoom].sort((a, b) => a.member.id.localeCompare(b.member.id))[0];
    if (alternative) return { chosen: alternative, selectionReason: `pinned member at its agent ceiling: priority ${alternative.member.priority}, same-tier member with capacity` };
    if (options.defersOnCapacity) throw refusal(pinnedTier);
    return { chosen: pinned, selectionReason: reason };
  }
  if (withRoom.length === 0 && options.defersOnCapacity) throw refusal(tier);
  const candidates = withRoom.length ? withRoom : tier;
  const capacityNote = withRoom.length && withRoom.length < tier.length ? ', skipped members at their agent ceiling' : '';
  if (options.strategy === 'usage_based') {
    const chosen = [...candidates].sort((a, b) => b.headroom - a.headroom || a.member.id.localeCompare(b.member.id))[0];
    return { chosen, selectionReason: `usage_based: priority ${highestPriority}, normalized headroom ${chosen.headroom.toFixed(4)}${capacityNote}` };
  }
  const cursor = await options.nextCursor();
  return { chosen: candidates[cursor % candidates.length], selectionReason: `round_robin: priority ${highestPriority}, cursor ${cursor}${capacityNote}` };
}
