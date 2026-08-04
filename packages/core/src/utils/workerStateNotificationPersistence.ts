import type { Knex } from 'knex';
import type {
  IssueRef,
  TaskState,
  TaskStateData,
  UpdateMetadata,
} from './workerStateManager.types.js';

export function buildPublishedTaskMetadata(
  issueNumber: number,
  attempts: number,
  metadata: UpdateMetadata,
  transitionSequence?: number
): Record<string, unknown> {
  const commandMode = typeof metadata.historyMetadata?.commandMode === 'string'
    ? metadata.historyMetadata.commandMode
    : undefined;
  const prNumber = typeof metadata.prResult?.prNumber === 'number'
    ? metadata.prResult.prNumber
    : commandMode === 'review' ? issueNumber : undefined;
  const prUrl = typeof metadata.prResult?.prUrl === 'string'
    ? metadata.prResult.prUrl
    : undefined;
  return {
    attempts,
    reason: metadata.reason,
    ...(commandMode === undefined ? {} : { commandMode }),
    ...(prNumber === undefined ? {} : { prNumber }),
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(transitionSequence === undefined ? {} : { transitionSequence })
  };
}

export function insertedSequence(value: unknown): number | undefined {
  const first = Array.isArray(value) ? value[0] : undefined;
  const candidate = typeof first === 'object' && first !== null
    ? (first as Record<string, unknown>).history_id
    : first;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : undefined;
}

function parseMetadataRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function appendTaskNotificationEnrichment(
  transaction: Knex.Transaction,
  input: {
    taskId: string;
    state: TaskState;
    transitionAt: string;
    transitionSequence?: number;
    changedAt: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  if (!await transaction.schema.hasTable('task_notification_enrichments')) return;
  await transaction('task_notification_enrichments').insert({
    task_id: input.taskId,
    state: input.state,
    transition_history_id: input.transitionSequence ?? null,
    transition_at: input.transitionAt,
    changed_at: input.changedAt,
    metadata: JSON.stringify(input.metadata)
  });
}

export async function persistIssueRefNotificationEnrichment(input: {
  database: Knex;
  taskId: string;
  state: TaskStateData;
  issueRefPatch: Partial<IssueRef>;
  transitionAt: string;
}): Promise<Record<string, unknown>> {
  const { database, taskId, state, issueRefPatch, transitionAt } = input;
  const durablePrNumber = typeof state.issueRef.pullRequestNumber === 'number'
    ? state.issueRef.pullRequestNumber
    : typeof state.issueRef.prNumber === 'number' ? state.issueRef.prNumber : undefined;
  return database.transaction(async (transaction) => {
    const taskRow = await transaction('tasks').select('initial_job_data')
      .where({ task_id: taskId }).first() as { initial_job_data?: unknown } | undefined;
    const initialJobData = { ...parseMetadataRecord(taskRow?.initial_job_data), ...state.issueRef };
    const taskUpdate: Record<string, unknown> = {
      initial_job_data: JSON.stringify(initialJobData),
      repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
      issue_number: state.issueRef.number
    };
    if ('pullRequestNumber' in issueRefPatch || 'prNumber' in issueRefPatch) {
      taskUpdate.pr_number = durablePrNumber ?? null;
    }
    await transaction('tasks').where({ task_id: taskId }).update(taskUpdate);
    const historyRow = await transaction('task_history').select('history_id')
      .where({ task_id: taskId, state: state.state, timestamp: transitionAt })
      .orderBy('history_id', 'desc').first() as { history_id?: number } | undefined;
    const publicationMetadata = {
      issueRefUpdated: true,
      updatedFields: Object.keys(issueRefPatch),
      transitionAt,
      ...(historyRow?.history_id === undefined ? {} : { transitionSequence: historyRow.history_id }),
      ...(typeof initialJobData.commandMode === 'string'
        ? { commandMode: initialJobData.commandMode } : {}),
      ...(durablePrNumber === undefined ? {} : { prNumber: durablePrNumber }),
      ...(typeof state.issueRef.prUrl === 'string' ? { prUrl: state.issueRef.prUrl } : {})
    };
    await appendTaskNotificationEnrichment(transaction, {
      taskId,
      state: state.state,
      transitionAt,
      transitionSequence: historyRow?.history_id,
      changedAt: state.updatedAt,
      metadata: publicationMetadata
    });
    return publicationMetadata;
  });
}

export async function persistHistoryMetadataNotificationEnrichment(input: {
  database: Knex;
  taskId: string;
  state: TaskStateData;
  historyState: TaskState;
  historyIndex: number;
  metadata: Record<string, unknown>;
  transitionAt: string;
}): Promise<Record<string, unknown>> {
  const { database, taskId, state, historyState, historyIndex, metadata, transitionAt } = input;
  return database.transaction(async (transaction) => {
    const historyRow = await transaction('task_history').select('history_id', 'metadata')
      .where({ task_id: taskId, state: historyState, timestamp: transitionAt })
      .orderBy('history_id', 'desc').first() as {
        history_id?: number;
        metadata?: unknown;
      } | undefined;
    const durableMetadata = {
      ...parseMetadataRecord(historyRow?.metadata),
      ...(state.history[historyIndex].metadata ?? {})
    };
    if (historyRow?.history_id !== undefined) {
      await transaction('task_history').where({ history_id: historyRow.history_id })
        .update({ metadata: JSON.stringify(durableMetadata) });
    }
    const prResult = parseMetadataRecord(durableMetadata.prResult);
    const pr = parseMetadataRecord(durableMetadata.pr);
    const prNumber = typeof prResult.prNumber === 'number'
      ? prResult.prNumber
      : typeof pr.number === 'number' ? pr.number : undefined;
    const prUrl = typeof prResult.prUrl === 'string'
      ? prResult.prUrl
      : typeof pr.url === 'string' ? pr.url : undefined;
    const publicationMetadata = {
      metadataUpdate: true,
      updatedFields: Object.keys(metadata),
      transitionAt,
      ...(historyRow?.history_id === undefined ? {} : { transitionSequence: historyRow.history_id }),
      ...(typeof durableMetadata.commandMode === 'string'
        ? { commandMode: durableMetadata.commandMode } : {}),
      ...(prNumber === undefined ? {} : { prNumber }),
      ...(prUrl === undefined ? {} : { prUrl })
    };
    await appendTaskNotificationEnrichment(transaction, {
      taskId,
      state: historyState,
      transitionAt,
      transitionSequence: historyRow?.history_id,
      changedAt: state.updatedAt,
      metadata: publicationMetadata
    });
    return publicationMetadata;
  });
}
