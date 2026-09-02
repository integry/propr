import type { GoalChecklistItem } from '@propr/core';
import type { PublicGoalChecklistItemDto } from '@propr/shared';

export function toPublicGoalChecklistItem(item: GoalChecklistItem): PublicGoalChecklistItemDto {
  return {
    sessionId: item.sessionId,
    itemId: item.itemId,
    text: item.text,
    status: item.status,
    source: item.source,
    orderIndex: item.orderIndex,
    eventSequence: item.eventSequence,
  };
}
