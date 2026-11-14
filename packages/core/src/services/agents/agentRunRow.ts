import {
  DEFAULT_AUTOMATION_AUTONOMY_MODE,
  isAutomationAutonomyMode,
  isAutomationReportNovelty,
  isAutomationRunState,
  type AutomationRunTrigger,
  type AutomationTriggerEvent,
} from '@propr/shared';
import type { StoredAgentDefinition } from './agentDefinitionStore.js';
import type { StoredAgentRun } from './agentRunStore.js';

/** An `agent_runs` row as the database returns it. Writes stay in `agentRunStore`. */
export interface AgentRunRow {
  id: string; definition_id: string; owner_id: string; trigger: string; trigger_source: string | null;
  idempotency_key: string | null; state: string; autonomy_mode: string; definition_snapshot: string;
  trigger_event?: string | null; trigger_subject?: string | null;
  report_task_id: string | null; action_task_id: string | null; report: string | null;
  report_truncated: boolean | number; action_summary: string | null; skip_reason: string | null;
  failure_reason: string | null; approved_by: string | null; operator_note: string | null; deferred_until: number | null; deferrals: number;
  report_hash?: string | null; report_novelty?: string | null; acting_mutations?: number | string | null; acting_mutations_pending?: boolean | number | null;
  created_at: number; started_at: number | null; reported_at: number | null; finished_at: number | null;
  updated_at: number;
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  return value == null ? null : Number(value);
}

/** A stored JSON object column; null when absent or unreadable. */
function parseSnapshot<T = StoredAgentDefinition>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

/** Pure row mapper. */
export function rowToAgentRun(row: AgentRunRow): StoredAgentRun {
  return {
    id: row.id,
    definitionId: row.definition_id,
    ownerId: row.owner_id,
    trigger: row.trigger as AutomationRunTrigger,
    triggerSource: row.trigger_source ?? null,
    triggerEvent: parseSnapshot<AutomationTriggerEvent>(row.trigger_event),
    triggerSubject: row.trigger_subject ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    // An unknown stored state is treated as failed so it is never picked up again.
    state: isAutomationRunState(row.state) ? row.state : 'failed',
    autonomyMode: isAutomationAutonomyMode(row.autonomy_mode) ? row.autonomy_mode : DEFAULT_AUTOMATION_AUTONOMY_MODE,
    definitionSnapshot: parseSnapshot(row.definition_snapshot),
    reportTaskId: row.report_task_id ?? null,
    actionTaskId: row.action_task_id ?? null,
    report: row.report ?? null,
    reportTruncated: Boolean(row.report_truncated),
    actionSummary: row.action_summary ?? null,
    skipReason: row.skip_reason ?? null,
    failureReason: row.failure_reason ?? null,
    approvedBy: row.approved_by ?? null,
    operatorNote: row.operator_note ?? null,
    deferredUntil: toNumberOrNull(row.deferred_until),
    deferrals: Number(row.deferrals ?? 0),
    reportHash: row.report_hash ?? null,
    reportNovelty: isAutomationReportNovelty(row.report_novelty) ? row.report_novelty : null,
    actingMutations: toNumberOrNull(row.acting_mutations),
    actingMutationsPending: Boolean(row.acting_mutations_pending),
    createdAt: Number(row.created_at),
    startedAt: toNumberOrNull(row.started_at),
    reportedAt: toNumberOrNull(row.reported_at),
    finishedAt: toNumberOrNull(row.finished_at),
    updatedAt: Number(row.updated_at),
  };
}
