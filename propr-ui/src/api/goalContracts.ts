/** Compatibility aliases only. Canonical goal DTOs live in @propr/shared. */
export {
  GOAL_STATES,
  GOAL_CANNED_ACTIONS,
  GOAL_MESSAGE_STATES,
  GOAL_CONTROL_APPLICATIONS,
  GOAL_EVENT_SCHEMA_VERSION,
  GOAL_EVENT_KINDS,
  GOAL_EVENT_TYPES,
} from '@propr/shared';

export type {
  CreateGoalRequest as CreateGoalRequestV1,
  GoalState,
  GoalCannedAction,
  GoalMessageState,
  GoalControlApplication,
  GoalControlCapability,
  GoalProviderCapabilities,
  GoalPolicyPreferences,
  PublicGoalDto as GoalRecordV1,
  GoalPlanItem,
  GoalPlanProjection,
  GoalNativeProviderState,
  GoalTokenBreakdown as GoalTokenBreakdownV1,
  GoalPassiveArtifacts,
  GoalStats as GoalDetailStatsV1,
  PublicGoalMessageDto as GoalMessageV1,
  PublicGoalDetailDto as GoalDetailV1,
  GoalSummaryView as GoalSummaryV1,
  GoalListResponse as GoalsListResponseV1,
  GoalEventKind,
  GoalEventType,
  GoalEventEnvelope as GoalEventV1,
  GoalJsonValue,
} from '@propr/shared';

import type { GoalEventEnvelope, GoalEventPage } from '@propr/shared';
export type GoalEventsPageV1 = GoalEventPage<GoalEventEnvelope>;
