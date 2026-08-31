import type {
  Goal,
  GoalDetail,
  GoalEvent,
  GoalMessage,
  GoalNode,
} from '@propr/core';
import type {
  PublicGoalDetailDto,
  PublicGoalDto,
  PublicGoalEventDto,
  PublicGoalMessageDto,
  PublicGoalNodeDto,
} from '@propr/shared';

/** Explicit public projections keep persistence/controller fields off the wire. */
export function toPublicGoal(goal: Goal): PublicGoalDto {
  return {
    goalId: goal.goalId,
    repository: goal.repository,
    objective: goal.objective,
    state: goal.state,
    agent: goal.agent,
    requestedModel: goal.requestedModel,
    effectiveModel: goal.effectiveModel,
    maxActiveTasks: goal.maxActiveTasks,
    ultrafixEnabled: goal.ultrafixEnabled,
    ultrafixGoal: goal.ultrafixGoal,
    ultrafixMaxCycles: goal.ultrafixMaxCycles,
    mergePolicy: goal.mergePolicy,
    version: goal.version,
    terminalReason: goal.terminalReason,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function toPublicGoalNode(node: GoalNode): PublicGoalNodeDto {
  return {
    nodeId: node.nodeId,
    goalId: node.goalId,
    parentNodeId: node.parentNodeId,
    kind: node.kind,
    externalRef: node.externalRef,
    externalKind: node.externalKind,
    title: node.title,
    status: node.status,
    orderIndex: node.orderIndex,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export function toPublicGoalMessage(message: GoalMessage): PublicGoalMessageDto {
  return {
    messageId: message.messageId,
    goalId: message.goalId,
    sequence: message.sequence,
    body: message.body,
    predefinedKind: message.predefinedKind,
    state: message.state,
    deliveredAt: message.deliveredAt,
    acknowledgedAt: message.acknowledgedAt,
    createdAt: message.createdAt,
  };
}

export function toPublicGoalEvent(event: GoalEvent): PublicGoalEventDto {
  return {
    goalId: event.goalId,
    sequence: event.sequence,
    kind: event.kind,
    eventType: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

export function toPublicGoalDetail(detail: GoalDetail): PublicGoalDetailDto {
  return {
    goal: toPublicGoal(detail.goal),
    nodes: detail.nodes.map(toPublicGoalNode),
    dependencies: detail.dependencies.map((dependency) => ({
      nodeId: dependency.nodeId,
      dependsOnNodeId: dependency.dependsOnNodeId,
    })),
    messages: detail.messages.map(toPublicGoalMessage),
    summary: detail.summary,
    stats: detail.stats,
  };
}
